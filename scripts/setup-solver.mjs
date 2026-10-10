import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Download directly from the author's release; no solver binary is distributed here.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, '.solver');
const version = 'v0.1.1';
const assets = {
  win32: ['TexasSolver-v0.1.1-Windowsx64.zip', 16549475],
  darwin: ['TexasSolver-V0.1.1-MacOs.zip', 17221483],
  linux: ['TexasSolver-V0.1.1-Linux.zip', 16867107],
};
const asset = assets[process.platform];
if (!asset || process.arch !== 'x64') throw new Error('自动安装仅支持 Windows/macOS/Linux x64；其他架构请自行编译并设置 TEXAS_SOLVER_PATH。');
const [name, expectedBytes] = asset;
const url = `https://github.com/bupticybee/TexasSolver/releases/download/${version}/${name}`;
const archive = join(cache, name);
const destination = join(cache, `TexasSolver-${version}-${process.platform}`);
const marker = join(cache, 'installing');

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`解压失败 (${code})：${output.slice(-1000)}`)));
  });
}

async function findExecutable(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isFile() && /^(console_solver|TexasSolverConsole)(\.exe)?$/i.test(entry.name)) return path;
    if (entry.isDirectory()) {
      const found = await findExecutable(path);
      if (found) return found;
    }
  }
  return null;
}

await mkdir(cache, { recursive: true });
await writeFile(marker, String(process.pid));
try {
  if (!existsSync(archive) || (await stat(archive)).size !== expectedBytes) {
    console.log(`从作者 GitHub Release 下载 TexasSolver ${version} console (${(expectedBytes / 1e6).toFixed(1)} MB)。`);
    const chunkSize = Math.ceil(expectedBytes / 8);
    const chunks = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const start = index * chunkSize;
      const end = Math.min(expectedBytes - 1, start + chunkSize - 1);
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(240000) });
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${expectedBytes}`) {
        throw new Error(`官方服务器未返回预期分块 (${response.status})，请从官方 Release 手动下载。`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length !== end - start + 1) throw new Error('下载不完整，请重试。');
      console.log(`下载分块 ${index + 1}/8 完成。`);
      return data;
    }));
    await writeFile(`${archive}.partial`, Buffer.concat(chunks));
    await rename(`${archive}.partial`, archive);
  }
  await mkdir(destination, { recursive: true });
  const listing = process.platform === 'linux'
    ? await run('unzip', ['-Z1', archive])
    : await run('tar', ['-tf', archive]);
  if (listing.split(/\r?\n/).some(path => path.startsWith('/') || /(^|[\\/])\.\.([\\/]|$)/.test(path))) {
    throw new Error('压缩包包含不安全的路径，已停止安装。');
  }
  if (process.platform === 'linux') await run('unzip', ['-o', '-q', archive, '-d', destination]);
  else await run('tar', ['-xf', archive, '-C', destination]);
  const executable = await findExecutable(destination);
  if (!executable || !existsSync(join(dirname(executable), 'resources', 'compairer', 'card5_dic_sorted.txt'))) {
    throw new Error('官方压缩包中未找到 console_solver 与完整 resources，请改用手动安装。');
  }
  if (process.platform !== 'win32') await run('chmod', ['+x', executable]);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(cache, 'engine.json'), JSON.stringify({ version, executable, source: url, archiveBytes: expectedBytes, sha256 }, null, 2));
  console.log('TexasSolver CLI 已安装到本机 .solver/，该目录不会提交 Git。可启动游戏进行个人练习。');
} finally {
  await rm(marker, { force: true });
}
