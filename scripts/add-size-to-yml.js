const fs = require('fs')
const path = require('path')

const releaseDir = path.join(__dirname, '../release')
const ymlPath = path.join(releaseDir, 'latest.yml')

if (!fs.existsSync(ymlPath)) {
  console.log('latest.yml 不存在，跳过')
  process.exit(0)
}

// 读取 yml 内容
const content = fs.readFileSync(ymlPath, 'utf-8')
const lines = content.split('\n')

// 从 yml 中提取文件名
const match = content.match(/path:\s*(.+\.exe)/)
if (!match) {
  console.log('未找到安装包文件名')
  process.exit(0)
}

const exeName = match[1].trim()
const exePath = path.join(releaseDir, exeName)

if (!fs.existsSync(exePath)) {
  console.log(`安装包不存在: ${exeName}`)
  process.exit(0)
}

// 获取文件大小
const stats = fs.statSync(exePath)
const size = stats.size

// electron-builder 新版本已经会生成 files[0].size，这里只在缺失时补齐，避免写出重复键
const newLines = []
let inFiles = false
let sizeAdded = false
let fileItemIndent = ''

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  newLines.push(line)
  
  if (line.startsWith('files:')) {
    inFiles = true
    fileItemIndent = ''
    continue
  }

  if (!inFiles) {
    continue
  }

  const trimmed = line.trim()
  const indent = line.match(/^\s*/)?.[0] || ''

  if (trimmed.startsWith('- ')) {
    fileItemIndent = `${indent}  `
    continue
  }

  if (trimmed.startsWith('size:')) {
    console.log('latest.yml 已包含 size，跳过写入')
    process.exit(0)
  }

  // 离开 files 块
  if (trimmed && !line.startsWith(' ') && !line.startsWith('\t')) {
    inFiles = false
    continue
  }

  // 在 files 块内的第一个 sha512 后添加 size
  if (!sizeAdded && trimmed.startsWith('sha512:')) {
    newLines.push(`${fileItemIndent || '    '}size: ${size}`)
    sizeAdded = true
    inFiles = false
  }
}

if (sizeAdded) {
  fs.writeFileSync(ymlPath, newLines.join('\n'))
  console.log(`已添加 size: ${size} 到 latest.yml`)
} else {
  console.log('未找到合适位置插入 size')
}
