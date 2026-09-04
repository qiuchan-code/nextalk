<script setup>
import { ref, onMounted } from 'vue'
import { useCharacters } from '../lib/characters.js'
import { useGroups, emptyGroup } from '../lib/groups.js'

const props = defineProps({
  groupId: { type: String, default: '' } // 传入就是编辑，空就是新建
})
const emit = defineEmits(['save', 'cancel'])

const chars = useCharacters()
const groups = useGroups()

const group = ref(emptyGroup())
const selected = ref(new Set()) // 用 Set 方便增删去重
const isEdit = props.groupId

const MIN_MEMBERS = 2
const MAX_MEMBERS = 5

onMounted(async () => {
  chars.reload()
  if (props.groupId) {
    const existing = await groups.getGroup(props.groupId)
    if (existing) {
      group.value = existing
      // 换新引用而不是原地 add：ref 里的 Set 原地改不一定触发渲染
      selected.value = new Set(existing.charIds || [])
    }
  }
})

function toggle(id) {
  const next = new Set(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    if (next.size >= MAX_MEMBERS) {
      alert(`最多 ${MAX_MEMBERS} 个角色（星野也是这个数）`)
      return
    }
    next.add(id)
  }
  selected.value = next
  group.value.charIds = [...next]
}

function back() {
  emit('cancel')
}

async function save() {
  const name = group.value.name.trim()
  if (!name) {
    alert('给房间起个名字吧')
    return
  }
  const members = [...selected.value]
  if (members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    alert(`选 ${MIN_MEMBERS}~${MAX_MEMBERS} 个角色（现在选了 ${members.length} 个）`)
    return
  }
  group.value.charIds = members
  await groups.saveGroup(group.value)
  emit('save', group.value.id) // 把房间 id 还回去，新建完直接进门
}
</script>

<template>
  <div class="edit">
    <div class="sheet paper-card">
      <span class="tape blue"></span>

      <h2 class="hand title">{{ isEdit ? '改改这个房间' : '搭一个房间' }}</h2>
      <p class="note">就像拉一个群：选齐角色，说清楚这是什么场合。它们不会自己说话——等你点谁、谁才回。</p>

      <label class="row">
        <span class="label hand">房间名</span>
        <input v-model.trim="group.name" class="field" placeholder="比如：大学宿舍的四个室友" maxlength="16" />
      </label>

      <label class="row">
        <span class="label hand">群描述（气氛全靠它）</span>
        <textarea
          v-model="group.desc"
          class="field multi"
          rows="3"
          placeholder="写清楚各位什么关系、什么场合。越具体越有戏。比如：四人老乡群里，程哥毒舌爱怼人，林妹妹一被怼就哭；你是不和他们同乡的同班同学，经常被他们拉来当裁判。"
        ></textarea>
      </label>

      <div class="row">
        <span class="label hand">
          成员
          <span class="note count">（{{ selected.size }}/{{ MAX_MEMBERS }} 个，至少 {{ MIN_MEMBERS }} 个）</span>
        </span>
        <template v-if="chars.state.loaded && chars.state.list.length">
          <div class="members">
            <button
              v-for="c in chars.state.list"
              :key="c.id"
              class="member"
              :class="{ on: selected.has(c.id) }"
              @click="toggle(c.id)"
            >
              <span class="avatar">
                <img v-if="c.avatar" :src="c.avatar" alt="" />
                <span v-else class="hand ph">{{ c.name.slice(0, 1) }}</span>
              </span>
              <span class="hand name">{{ c.name }}</span>
            </button>
          </div>
        </template>
        <p v-else class="note">还没有角色可拉。先回首页捏一两个。</p>
      </div>

      <div class="actions">
        <button class="btn" @click="back">返回</button>
        <button class="btn primary" @click="save">{{ isEdit ? '保存修改' : '搭好它' }}</button>
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
.count {
  font-size: 12px;
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

.members {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.member {
  width: 84px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px 6px;
  border: 1.5px solid var(--paper-edge);
  background: var(--paper-card);
  border-radius: 10px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: transform 0.1s, border-color 0.1s;
}
.member:hover {
  transform: rotate(-1.2deg);
}
.member.on {
  border-color: var(--ink);
  background: var(--paper-sticky);
  box-shadow: 0 0 0 2px var(--ink), var(--shadow-card);
}
.avatar {
  width: 46px;
  height: 46px;
  border-radius: 9px;
  overflow: hidden;
  background: #efe8d6;
  display: grid;
  place-items: center;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ph {
  font-size: 20px;
  color: var(--ink-pencil);
}
.name {
  font-size: 13px;
  color: var(--ink);
  max-width: 78px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
  flex-wrap: wrap;
}
</style>
