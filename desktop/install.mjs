/**
 * 一键部署到桌面：生成图标 → 生成无窗口启动脚本 → 创建桌面 / 开始菜单快捷方式
 * 用法：node desktop/install.mjs          安装
 *       node desktop/install.mjs --remove  移除快捷方式
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const NODE = process.execPath;
const VBS = path.join(DESKTOP_DIR, 'start.vbs');
const ICON = path.join(DESKTOP_DIR, 'icon.ico');
const LNK_NAME = 'AGENTFORGE.lnk';
const remove = process.argv.includes('--remove');

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true },
  );
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || 'PowerShell 执行失败').trim());
  }
  return (res.stdout || '').trim();
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

if (remove) {
  const out = runPowerShell(`
$ErrorActionPreference = 'Stop'
$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))
foreach ($d in $dirs) {
  $p = Join-Path $d ${q(LNK_NAME)}
  if (Test-Path $p) { Remove-Item $p -Force; Write-Output "removed $p" }
}
`);
  console.log(out || '没有找到快捷方式');
  process.exit(0);
}

/* 1. 图标 */
console.log('› 生成应用图标…');
const iconRes = spawnSync(NODE, [path.join(DESKTOP_DIR, 'make-icon.mjs')], { encoding: 'utf8' });
if (iconRes.status !== 0) throw new Error(iconRes.stderr || '图标生成失败');
console.log('  ' + (iconRes.stdout || '').trim().replace(/\n/g, '\n  '));

/* 2. 无窗口启动脚本（UTF-16LE，兼容中文路径） */
console.log('› 生成启动脚本…');
const vbs = [
  "' AGENTFORGE 桌面启动脚本（由 install.mjs 生成）",
  'Set sh = CreateObject("WScript.Shell")',
  `sh.CurrentDirectory = "${ROOT}"`,
  `sh.Run """${NODE}"" ""${path.join(DESKTOP_DIR, 'launcher.mjs')}""", 0, False`,
  '',
].join('\r\n');
fs.writeFileSync(VBS, '\ufeff' + vbs, 'utf16le');

/* 3. 快捷方式 */
console.log('› 创建快捷方式…');
const out = runPowerShell(`
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  $lnk = $ws.CreateShortcut((Join-Path $d ${q(LNK_NAME)}))
  $lnk.TargetPath = (Join-Path $env:SystemRoot 'System32\\wscript.exe')
  $lnk.Arguments = ${q('"' + VBS + '"')}
  $lnk.WorkingDirectory = ${q(ROOT)}
  $lnk.IconLocation = ${q(ICON)}
  $lnk.Description = 'AGENTFORGE - 多智能体开发协作台'
  $lnk.WindowStyle = 1
  $lnk.Save()
  Write-Output $lnk.FullName
}
`);
console.log(out ? out.split(/\r?\n/).map((l) => '  ' + l).join('\n') : '  未创建（找不到桌面目录）');

console.log('');
console.log('✅ 部署完成。双击桌面上的 AGENTFORGE 即可启动（无控制台窗口）。');
console.log(`   运行日志：%LOCALAPPDATA%\\AgentForge\\logs\\`);
