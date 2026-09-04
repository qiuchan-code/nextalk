<script setup>
import { ref, onMounted } from 'vue'
import { useCharacters, emptyCharacter, compressAvatar } from '../lib/characters.js'
import { getAffinity, setAffinity } from '../lib/memory.js'
import { affinityLevel } from '../lib/prompt.js'

const props = defineProps({
  charId: { type: String, default: '' } // 传入就是编辑，空就是新建
})
const emit = defineEmits(['save', 'cancel'])
const { saveCharacter, getCharacter } = useCharacters()

const char = ref(emptyCharacter())
const styleText = ref('')
const compressBusy = ref(false)
const loaded = ref(false)
const isEdit = props.charId // 新建与否在 setup 里定，生命周期里不变

const traitMeta = [
  { key: 'rational', name: '理性', high: '讲逻辑', low: '凭感觉' },
  { key: 'humor', name: '幽默', high: '爱贫嘴', low: '正经' },
  { key: 'empathy', name: '共情', high: '照顾情绪', low: '就事论事' },
  { key: 'proactive', name: '主动', high: '话痨', low: '被动' }
]

onMounted(async () => {
  if (props.charId) {
    const existing = await getCharacter(props.charId)
    if (existing) {
      char.value = existing
      styleText.value = (existing.styleLines || []).join('\n')
      // 亲密度显示当前值：编辑时别让滑块盖掉已经聊出来的变化
      const aff = await getAffinity(props.charId)
      char.value.affinity = aff ?? char.value.affinity ?? 50
    }
  }
  loaded.value = true
})

function pickAvatar(e) {
  const file = e.target.files?.[0]
  if (!file) return
  compressBusy.value = true
  compressAvatar(file)
    .then((dataUrl) => (char.value.avatar = dataUrl))
    .catch((err) => alert(err.message))
    .finally(() => {
      compressBusy.value = false
      e.target.value = ''
    })
}

function back() {
  emit('cancel')
}

async function save() {
  if (!char.value.name.trim()) {
    alert('至少给它起个名字吧')
    return
  }
  char.value.styleLines = styleText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  await saveCharacter(char.value)
  // 亲密度落进 relationship 记忆：新角色=初始值，改角色=手动掰回来
  await setAffinity(char.value.id, char.value.affinity ?? 50)
  emit('save')
}
</script>

<template>
  <div class="edit">
    <div class="sheet paper-card">
      <span class="tape blue"></span>

      <h2 class="hand title">{{ isEdit ? '改改它' : '捏一个角色' }}</h2>
      <p class="note">{{ isEdit ? '改完保存，它所有对话线都会用新的人设。' : '形象、性格、说话方式，都随你。' }}</p>

      <!-- 头像：拍立得 -->
      <div class="avatar-row">
        <label class="polaroid">
          <img v-if="char.avatar" :src="char.avatar" class="preview" alt="头像" />
          <div v-else class="preview empty hand">{{ compressBusy ? '处理中…' : '＋' }}</div>
          <input type="file" accept="image/*" hidden @change="pickAvatar" />
          <span class="tape"></span>
        </label>
        <div class="avatar-hint note">
          <p>放一张照片或立绘，</p>
          <p>会自动压小存进去。不爱放也行。</p>
        </div>
      </div>

      <label class="row">
        <span class="label hand">名字</span>
        <input v-model="char.name" class="field" placeholder="比如：阿澄" maxlength="12" />
      </label>

      <label class="row">
        <span class="label hand">它是什么来头？</span>
        <textarea
          v-model="char.backstory"
          class="field multi"
          rows="4"
          placeholder="背景故事、身份、性格、经历…写多细都行，它会照着演。"
        ></textarea>
      </label>

      <label class="row">
        <span class="label hand">跟你说的开场白</span>
        <textarea
          v-model="char.greeting"
          class="field multi"
          rows="2"
          placeholder="比如：你终于来啦？我等半天了。"
        ></textarea>
      </label>

      <label class="row">
        <span class="label hand">它平时怎么说话（可选，几行例子）</span>
        <textarea
          v-model="styleText"
          class="field multi"
          rows="3"
          placeholder="每行一句，模仿这个语气。\n比如：\n别磨蹭啦，快上课了。\n哎，你今天怎么蔫蔫的？"
        ></textarea>
      </label>

      <!-- 性格滑块 -->
      <div class="traits">
        <p class="hand section-note">性格</p>

        <div v-for="t in traitMeta" :key="t.key" class="trait">
          <div class="trait-head">
            <span class="hand trait-name">{{ t.name }}</span>
            <span class="note trait-desc">{{ t.high }}</span>
            <input
              v-model.number="char.traits[t.key]"
              class="slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
            />
            <span class="note trait-desc">{{ t.low }}</span>
          </div>
          <div class="bar">
            <div class="fill" :style="{ width: char.traits[t.key] * 100 + '%' }"></div>
          </div>
        </div>

        <!-- 亲密度：初始值和手动调整都在这 -->
        <div class="trait affinity">
          <div class="trait-head">
            <span class="hand trait-name">亲密度</span>
            <span class="note trait-desc">{{ affinityLevel(char.affinity) }}</span>
            <input
              v-model.number="char.affinity"
              class="slider"
              type="range"
              min="0"
              max="100"
              step="1"
            />
            <span class="note trait-desc">{{ Math.round(char.affinity || 0) }}</span>
          </div>
          <div class="bar">
            <div class="fill fill-aff" :style="{ width: (char.affinity / 100) * 100 + '%' }"></div>
          </div>
          <p class="note hint-aff">0 陌生 → 100 交心。先定它们相遇时的亲近程度；之后聊天会自然变化，想掰回来，回来改这个。</p>
        </div>
      </div>

      <div class="actions">
        <button class="btn" @click="back">返回</button>
        <button class="btn primary" @click="save">{{ isEdit ? '保存修改' : '保存这个角色' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.edit {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 16px calc(26px + env(safe-area-inset-bottom));
  display: flex;
  justify-content: center;
}
.sheet {
  width: 100%;
  max-width: 560px;
  transform: rotate(-0.3deg);
}
.title {
  font-size: 21px;
  margin: 4px 0 2px;
  letter-spacing: 1px;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 16px 0 4px;
}
.polaroid {
  position: relative;
  background: #fbf8f0;
  border: 1px solid var(--paper-edge);
  padding: 6px 6px 20px;
  box-shadow: var(--shadow-card);
  cursor: pointer;
  transform: rotate(-2deg);
  flex: none;
}
.preview {
  width: 104px;
  height: 104px;
  object-fit: cover;
  display: grid;
  place-items: center;
  background: #efe8d6;
  font-size: 30px;
  color: var(--ink-pencil);
}
.avatar-hint p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-pencil);
}

.row {
  display: block;
  margin: 14px 0;
}
.label {
  display: block;
  font-size: 14px;
  color: var(--ink-soft);
  margin-bottom: 4px;
}
.field.multi {
  border: 1.5px dashed var(--line);
  border-radius: 3px;
  padding: 9px 10px;
  resize: vertical;
  font-size: 15px;
  font-family: var(--font-body);
  color: var(--ink);
  background: transparent;
  line-height: 1.7;
  outline: none;
}
.field.multi:focus {
  border-color: var(--ink-blue);
  border-style: solid;
}

.traits {
  margin-top: 16px;
}
.section-note {
  color: var(--ink-soft);
  font-size: 15px;
  margin: 0 0 10px;
}
.trait {
  margin: 15px 0;
}
.trait-head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.trait-name {
  font-size: 15px;
  width: 34px;
  flex: none;
}
.trait-desc {
  font-size: 13px;
  color: var(--ink-pencil);
  flex: none;
}
.trait-desc:last-child {
  text-align: right;
  min-width: 44px;
}
.slider {
  flex: 1;
  min-width: 0;
  accent-color: #c9a55a;
  margin: 0 4px;
}
.bar {
  height: 4px;
  background: var(--line-soft);
  border-radius: 2px;
  margin-top: 6px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: rgba(201, 165, 90, 0.6);
  border-radius: 2px;
  transition: width 0.1s;
}
.fill-aff {
  background: rgba(214, 118, 96, 0.55); /* 亲密度用暖一点的颜色，跟性格的土黄区分开 */
}
.trait.affinity {
  margin-top: 22px;
}
.hint-aff {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
  flex-wrap: wrap;
}
</style>
