import { connect } from './ciphertalk-plugin-sdk.js'

const VOICE_TYPE = 34 // 微信语音消息 localType
const TEXT_TYPE = 1

const $ = (id) => document.getElementById(id)
const log = (line) => { $('log').textContent += `${line}\n`; $('log').scrollTop = $('log').scrollHeight }

const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '就', '不', '也',
  '都', '和', '与', '这', '那', '个', '啊', '吧', '吗', '呢', '哈', '嗯', '哦',
])

function tokenize(text) {
  const tokens = []
  for (const latin of text.matchAll(/[a-zA-Z]{2,}/g)) tokens.push(latin[0].toLowerCase())
  for (const run of text.matchAll(/[一-鿿]{2,}/g)) {
    for (let i = 0; i < run[0].length - 1; i++) tokens.push(run[0].slice(i, i + 2))
  }
  return tokens.filter((t) => !STOP_WORDS.has(t))
}

/** 拉取会话消息（最多 4 页），可按类型过滤 */
async function fetchMessages(api, sessionId, types) {
  const rows = []
  let cursor
  for (let page = 0; page < 4; page++) {
    const result = await api.data.messages.query({ sessionId, limit: 500, cursor })
    for (const row of result.rows) {
      if (!types || types.includes(row.type)) rows.push(row)
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return rows
}

async function main() {
  const api = await connect()
  const { sessionId, sessionName } = api.context
  $('session-name').textContent = sessionName || sessionId || '（无会话上下文）'
  if (!sessionId) {
    for (const id of ['btn-transcribe', 'btn-freq', 'btn-export']) $(id).disabled = true
    return
  }

  const transcripts = []

  $('btn-transcribe').addEventListener('click', async () => {
    $('btn-transcribe').disabled = true
    try {
      const voices = await fetchMessages(api, sessionId, [VOICE_TYPE])
      log(`找到 ${voices.length} 条语音消息`)
      let done = 0
      for (const voice of voices) {
        try {
          const result = await api.stt.transcribe({
            sessionId, localId: voice.localId, createTime: voice.createTime, serverId: voice.serverId,
          })
          transcripts.push(result.text)
          done++
          log(`[${done}/${voices.length}]${result.fromCache ? '（缓存）' : ''} ${result.text.slice(0, 40)}`)
        } catch (e) {
          log(`转写失败 localId=${voice.localId}: ${e.message}`)
        }
      }
      await api.ui.toast(`转写完成：${done}/${voices.length}`)
    } finally {
      $('btn-transcribe').disabled = false
    }
  })

  $('btn-freq').addEventListener('click', async () => {
    $('btn-freq').disabled = true
    try {
      const texts = (await fetchMessages(api, sessionId, [TEXT_TYPE])).map((m) => m.content || '')
      const counts = new Map()
      for (const text of [...texts, ...transcripts]) {
        for (const token of tokenize(text)) counts.set(token, (counts.get(token) || 0) + 1)
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
      $('cloud').innerHTML = ''
      for (const [word, count] of top) {
        const chip = document.createElement('span')
        chip.className = 'ct-chip'
        chip.textContent = `${word} ${count}`
        $('cloud').appendChild(chip)
      }
      log(`统计完成：${texts.length} 条文本 + ${transcripts.length} 条转写`)
    } finally {
      $('btn-freq').disabled = false
    }
  })

  $('btn-export').addEventListener('click', async () => {
    $('btn-export').disabled = true
    try {
      api.events.on('exportProgress', (p) => log(`导出进度：${JSON.stringify(p).slice(0, 100)}`))
      api.events.on('exportDone', (p) => {
        log(p.success === false ? `导出失败：${p.error}` : `导出完成：${p.outputPath || ''}`)
        $('btn-export').disabled = false
      })
      const result = await api.export.exportSession({ sessionId, format: 'html' })
      if (result.canceled) {
        log('已取消导出')
        $('btn-export').disabled = false
      } else {
        log(`导出任务已启动：${result.outputPath}`)
      }
    } catch (e) {
      log(`导出失败：${e.message}`)
      $('btn-export').disabled = false
    }
  })
}

main().catch((e) => log(`初始化失败：${e.message}`))
