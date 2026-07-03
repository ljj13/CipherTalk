import { connect } from './ciphertalk-plugin-sdk.js'

const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '就', '不', '也',
  '都', '和', '与', '这', '那', '个', '啊', '吧', '吗', '呢', '哈', '嗯', '哦',
  'the', 'a', 'is', 'to', 'and', 'of', 'in', 'it',
])

/** 简易分词：拉丁词按空白切，中文取滑动二字组合（演示用，无需分词库） */
function tokenize(text) {
  const tokens = []
  for (const latin of text.matchAll(/[a-zA-Z]{2,}/g)) {
    tokens.push(latin[0].toLowerCase())
  }
  for (const cjkRun of text.matchAll(/[一-鿿]{2,}/g)) {
    const run = cjkRun[0]
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens.filter((t) => !STOP_WORDS.has(t))
}

const $ = (id) => document.getElementById(id)

async function analyze(api, sessionId) {
  $('cloud').innerHTML = ''
  $('status').textContent = '读取消息中…'

  const counts = new Map()
  let cursor
  let total = 0
  // 最多翻 4 页（约 2000 条），演示分页游标用法
  for (let page = 0; page < 4; page++) {
    const result = await api.data.messages.query({ sessionId, limit: 500, cursor })
    for (const row of result.rows) {
      if (row.type !== 1) continue // 只统计文本消息
      total++
      for (const token of tokenize(row.content || '')) {
        counts.set(token, (counts.get(token) || 0) + 1)
      }
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
  $('status').textContent = `统计了 ${total} 条文本消息，展示前 ${top.length} 个高频词`

  for (const [word, count] of top) {
    const chip = document.createElement('span')
    chip.className = 'ct-chip'
    chip.innerHTML = `${word}<span class="count">${count}</span>`
    chip.addEventListener('click', async () => {
      await api.clipboard.write(word)
      await api.ui.toast(`已复制「${word}」`)
    })
    $('cloud').appendChild(chip)
  }
}

async function main() {
  const api = await connect()
  const select = $('session-select')

  const { sessions } = await api.data.sessions.list({ limit: 100 })
  select.innerHTML = '<option value="">选择会话…</option>'
  for (const session of sessions) {
    const option = document.createElement('option')
    option.value = session.sessionId
    option.textContent = session.displayName || session.sessionId
    select.appendChild(option)
  }

  select.addEventListener('change', () => {
    if (select.value) {
      analyze(api, select.value).catch((e) => {
        $('status').textContent = `统计失败：${e.message}`
      })
    }
  })
}

main().catch((e) => {
  $('status').textContent = `初始化失败:${e.message}`
})
