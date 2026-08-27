<script setup>
import { ref } from 'vue'
import { settings, PROVIDERS, isConfigured } from '../lib/settings.js'
import { chatOnce } from '../lib/client.js'
import { exportAll, importAll } from '../lib/backup.js'

const emit = defineEmits(['done'])

const testing = ref(false)
const testResult = ref(null) // { ok: boolean, text: string }
const backupMsg = ref(null) // { ok, text }
const backupBusy = ref(false)

async function doExport() {
  backupBusy.value = true
  backupMsg.value = null
  try {
    const info = await exportAll()
    backupMsg.value = { ok: true, text: `已导出：${info.characters} 个角色、${info.messages} 条消息（API Key 不算在内）` }
  } catch (err) {
    backupMsg.value = { ok: false, text: '导出失败：' + (err.message || err) }
  } finally {
    backupBusy.value = false
  }
}

async function doImport(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (!confirm(`导入会覆盖当前所有角色和聊天记录，确定吗？`)) {
    e.target.value = ''
    return
  }
  backupBusy.value = true
  backupMsg.value = null
  try {
    const info = await importAll(file)
    backupMsg.value = { ok: true, text: `已恢复：${info.characters} 个角色。等会儿回聊天页刷一下。` }
  } catch (err) {
    backupMsg.value = { ok: false, text: '导入失败：' + (err.message || err) }
  } finally {
    backupBusy.value = false
    e.target.value = ''
  }
}

function applyPreset(p) {
  settings.endpoint = p.endpoint
  settings.model = p.model
  testResult.value = null
}

function isCurrent(p) {
  return settings.endpoint === p.endpoint
}

async function testConnection() {
  if (!settings.apiKey) {
    testResult.value = { ok: false, text: 'Key 还没填呢' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const reply = await chatOnce({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: [{ role: 'user', content: '回复两个字：在的' }],
      maxTokens: 20
    })
    testResult.value = { ok: true, text: `通了！它说："${reply.trim().slice(0, 40)}"` }
  } catch (err) {
    testResult.value = { ok: false, text: String(err.message || err) }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="settings-scroll">
    <div class="sheet paper-card">
      <span class="tape blue"></span>

      <h2 class="hand section-title">先接上模型</h2>
      <p class="note">选一家，填上你的 Key。以后想换随时回来改，不用改代码。</p>

      <div class="providers">
        <button
          v-for="(p, i) in PROVIDERS"
          :key="p.name"
          class="provider"
          :class="{ on: isCurrent(p), dead: !p.canBrowser }"
          :style="{ transform: `rotate(${(i % 2 ? 1 : -1) * (0.6 + (i % 3) * 0.35)}deg)` }"
          :disabled="!p.canBrowser"
          @click="applyPreset(p)"
        >
          <strong class="hand">{{ p.name }}</strong>
          <span class="note tiny">{{ p.note }}</span>
        </button>
      </div>

      <label class="row">
        <span class="label hand">接口地址</span>
        <input v-model.trim="settings.endpoint" class="field" placeholder="https://..." />
      </label>

      <label class="row">
        <span class="label hand">API Key</span>
        <input
          v-model.trim="settings.apiKey"
          class="field"
          type="password"
          autocomplete="off"
          placeholder="sk-..."
        />
      </label>

      <label class="row">
        <span class="label hand">模型名</span>
        <input v-model.trim="settings.model" class="field" placeholder="deepseek-chat" />
      </label>

      <div class="actions">
        <button class="btn" :disabled="testing" @click="testConnection">
          {{ testing ? '正在试…' : '测一下通不通' }}
        </button>
        <button class="btn primary" :disabled="!isConfigured()" @click="emit('done')">
          去聊天 →
        </button>
      </div>

      <p v-if="testResult" class="result" :class="testResult.ok ? 'good' : 'bad'">
        {{ testResult.text }}
      </p>
    </div>

    <div class="sheet paper-card slim">
      <span class="tape pink"></span>
      <h2 class="hand section-title">细节调整</h2>

      <label class="row inline">
        <span class="label hand">单次回复上限</span>
        <input v-model.number="settings.maxTokens" class="field short" type="number" min="128" step="128" />
        <span class="note tiny">token，越大越能写长，也越费钱</span>
      </label>

      <label class="row inline">
        <span class="label hand">带多少条历史</span>
        <input v-model.number="settings.historyWindow" class="field short" type="number" min="4" step="2" />
        <span class="note tiny">每次发给模型的原文条数，更早的会压成剧情摘要</span>
      </label>
    </div>

    <div class="sheet paper-card slim">
      <span class="tape green"></span>
      <h2 class="hand section-title">数据备份</h2>
      <p class="note">数据都存在这台设备的浏览器里，清缓存会丢。重要的角色和聊天，隔一阵导出一份留档。</p>
      <div class="actions">
        <button class="btn" :disabled="backupBusy" @click="doExport">导出备份</button>
        <label class="btn" :disabled="backupBusy">
          导入恢复
          <input type="file" accept="application/json" hidden @change="doImport" />
        </label>
      </div>
      <p v-if="backupMsg" class="result" :class="backupMsg.ok ? 'good' : 'bad'">{{ backupMsg.text }}</p>
    </div>

    <p class="note footnote">
      Key 只存在这台设备的浏览器里，不会上传到任何地方。<br />
      换设备或清了缓存要重新填一次。
    </p>
  </div>
</template>

<style scoped>
.settings-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 16px calc(28px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

.sheet {
  width: 100%;
  max-width: 520px;
  padding: 22px 20px 18px;
  transform: rotate(-0.4deg);
}
.sheet.slim {
  transform: rotate(0.5deg);
}

.section-title {
  margin: 4px 0 4px;
  font-size: 19px;
  letter-spacing: 1px;
}

.providers {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin: 14px 0 18px;
}
.provider {
  flex: 1 1 152px;
  text-align: left;
  background: var(--paper-sticky);
  border: 1px solid rgba(160, 140, 90, 0.35);
  border-radius: 2px;
  padding: 8px 10px;
  cursor: pointer;
  box-shadow: 1px 2px 0 rgba(140, 120, 80, 0.15);
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: box-shadow 0.1s;
}
.provider:hover:not(:disabled) {
  box-shadow: 2px 3px 0 rgba(140, 120, 80, 0.22);
}
.provider.on {
  background: #fce9a8;
  border-color: var(--ink);
  box-shadow: 2px 3px 0 rgba(120, 100, 60, 0.3);
}
.provider.dead {
  background: #efe9dc;
  opacity: 0.6;
  cursor: not-allowed;
  text-decoration: line-through solid rgba(120, 100, 80, 0.5);
}
.provider strong {
  font-size: 15px;
}
.tiny {
  font-size: 12px;
  line-height: 1.45;
}

.row {
  display: block;
  margin: 13px 0;
}
.row.inline {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.label {
  display: inline-block;
  font-size: 14px;
  color: var(--ink-soft);
  margin-bottom: 2px;
}
.field.short {
  width: 88px;
  flex: none;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.result {
  margin: 12px 0 0;
  font-family: var(--font-hand);
  font-size: 14px;
  white-space: pre-wrap;
  line-height: 1.6;
  padding: 8px 10px;
  border-left: 3px solid;
}
.result.good {
  color: var(--ink-green);
  border-color: var(--ink-green);
  background: rgba(120, 170, 140, 0.09);
}
.result.bad {
  color: var(--ink-red);
  border-color: var(--ink-red);
  background: rgba(194, 85, 77, 0.07);
}

.footnote {
  max-width: 520px;
  text-align: center;
  line-height: 1.7;
  transform: rotate(-0.5deg);
}
</style>
