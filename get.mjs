#!/usr/bin/env node
import { get } from 'https'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createWriteStream } from 'fs'
import { stat, mkdir, unlink } from 'fs/promises'
import { spawn } from 'child_process'

const $ = f => new Promise(f)
const run = (
	{ cwd
	, env = process.env
	, stdio = 'inherit'
	}
) => (
	cmd,
	...args
) => $((ok, err) => {
	const process = spawn(cmd, args, {cwd, env, stdio, shell: false})
	process.once('exit', code => code === 0 ? ok() : err(new Error(
		`${cmd} exits with non-zero code ${code}`
	)))
	process.once('error', err)
})

const requestR = (url, options = {}) => $(
	(ok, err) => get(url, options, res => {
		if (res.statusCode !== 200) {
			res.destroy()
			return err({
				data: res,
				message: `[${res.statusCode}] getting ${url} has failed`
			})
		}

		ok(res)
	}).once('error', err)
)

const getTextR = async (...args) => {
	const res = await requestR(...args)
	res.setEncoding('utf8')

	let text = ''
	res.on('data', v => text += v)

	return await $(
		ok => res.once('end', () => ok(text))
	)
}

const domainTable = {}
const resolve4 = domain => {
	if (domain in domainTable) return domainTable[domain]
	const result = getTextR(
		`https://cloudflare-dns.com/dns-query?type=A&name=${domain}`,
		{ headers: { accept: 'application/dns-json' } },
	).then(data => JSON.parse(data).Answer[0].data)
	domainTable[domain] = result
	return result
}

const cfOptions = async (url, options = {}) => ({
	...options,
	family: 4,
	// hostname: await resolve4(url.host),
	// setHost: false,
	// header: { 'host': url.host },
	async lookup(hostname, options, callback) {
		callback(null, await resolve4(hostname), 4)
	}
})

const request = async (url, options = {}) =>
	await requestR(url, await cfOptions(url, options))

const getText = async (url, options = {}) =>
	await getTextR(url, await cfOptions(url, options))

const downloadZip = async (url, {cwd, progress = null}) => {
	const name = url.pathname.split('/').pop().trim()
	if (name === '') {
		throw new Error(`hey I think ${name} is awkward?`)
	}
	const path = join(cwd, name)

	const res = await request(url)
	if (!res.headers['content-type'].startsWith('application/zip')) {
		res.destroy()
		throw new Error(`${url} is not a zip file`)
	}

	const total = parseInt(res.headers['content-length'].trim(), 10)

	let timeout = setTimeout(() => {})

	const stream = createWriteStream(path, { flags: 'wx' })
	stream.once('ready', () => {
		if (typeof progress === 'function') {
			timeout = setInterval(() =>
				progress({ path, bytes: stream.bytesWritten, total })
			, 5000)
		}
	})

	return await $(
		(ok, err) => {
			res.pipe(stream)
			stream.once('error', e => {
				clearTimeout(timeout)
				err(e)
			})

			stream.once('close', () => {
				clearTimeout(timeout)
				const bytes = stream.bytesWritten
				progress({ path, bytes, total })
				stream.destroy()
				ok({ path, bytes })
			})
		}
	)

	return res
}

const xz = async (
	input,
	folder,
	{ cwd
	, name = input.split('/').pop().split('.')[0]
	}
) => {
	const sh = run({ cwd })

	await sh('unar', '-no-directory', '-output-directory', folder, input )
	unlink(input)
	await sh('tar',
		'--remove-files',
		'-vcI', 'xz -v9eT 0',
		'-C', folder,
		'-f', `${name}.tar.xz`,
		'.',
	)
}

const mib = bytes => Math.round(bytes / 1024 / 1024 * 100) / 100 + ' MiB'
const percentage = ratio => Math.round(ratio * 10000) / 100 + '%'

const progress = ({path, bytes, total}) => console.log(
	`${path} \t ${mib(bytes)} / ${mib(total)} ${percentage(bytes/total)}`
)

const dependency = cwd => {
	const sh = run({ cwd, stdio: 'ignore' })
	const check = cmd => sh('which', cmd).catch(() => Promise.reject(
		new Error(`You have no ${cmd}`)
	))

	return Promise.all([
		'unar',
		'tar',
		'xz',
	].map(check))
}

const main = (url => async cwd => {
	await dependency(process.cwd())

	cwd = join(process.cwd(), cwd)
	await mkdir(cwd)

	const baseUrl = new URL(url)
	const body = await getText(baseUrl)

	const urls = Array.from(
		body.matchAll(/<a\s+[^>]*href="([^"]+\.zip)"[^>]*>/g), v => {
			if (v[0].includes('title="다운로드"')) {
				try {
					return new URL(v[1], baseUrl)
				} catch (_) {}
			}

			return null
		}
	).filter(v => v != null)

	await Promise.all(
		urls.map(async (url, index) => {
			const { path } = await downloadZip(url, { cwd, progress })
			await xz(path, join(cwd, `temp-${index}`), { cwd })
		})
	)
})(
	'https://www.epost.go.kr/search/zipcode/areacdAddressDown.jsp'
)

const param = process.argv[2]
const isMain = import.meta.main ||
	process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
	if (!param) {
		console.error('specify new dir to unpack')
		process.exit(1)
	}

	main(param).catch(v => {
		console.error(v.message)
		process.exit(1)
	})
}
