<script setup lang="ts">
import { ref, watch } from 'vue';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';

const props = defineProps<{ modelValue: JSONContent; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [JSONContent] }>();
const linkDialog = ref(false);
const linkUrl = ref('');
const linkError = ref('');
const editor = useEditor({
  extensions: [StarterKit.configure({ link: { openOnClick: false } })],
  content: props.modelValue,
  editable: !props.readonly,
  editorProps: {
    attributes: { 'aria-label': '采购说明', role: 'textbox', 'aria-multiline': 'true' },
  },
  onUpdate: ({ editor }) => emit('update:modelValue', editor.getJSON()),
});

watch(() => props.modelValue, value => {
  if (editor.value && JSON.stringify(editor.value.getJSON()) !== JSON.stringify(value)) {
    editor.value.commands.setContent(value, { emitUpdate: false, errorOnInvalidContent: true });
  }
}, { deep: true });
watch(() => props.readonly, value => editor.value?.setEditable(!value, false));

/** Retain the selected text while the URL dialog has focus. */
function openLink() {
  linkUrl.value = editor.value!.getAttributes('link').href || '';
  linkError.value = '';
  linkDialog.value = true;
}
/** Apply an explicitly entered web address to the current selection. */
function saveLink() {
  let url: URL;
  try {
    url = new URL(linkUrl.value.trim());
  } catch {
    linkError.value = '请输入完整的 HTTP 或 HTTPS 网址';
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    linkError.value = '请输入完整的 HTTP 或 HTTPS 网址';
    return;
  }
  editor.value!.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run();
  linkDialog.value = false;
}
</script>

<template>
  <div class="rich">
    <div v-if="editor && !readonly" class="tools" role="toolbar" aria-label="采购说明格式">
      <el-button size="small" :aria-pressed="editor.isActive('paragraph')" @mousedown.prevent @click="editor.chain().focus().setParagraph().run()">正文</el-button>
      <el-button v-for="level in ([2, 3] as const)" :key="level" size="small" :aria-pressed="editor.isActive('heading', { level })" @mousedown.prevent @click="editor.chain().focus().toggleHeading({ level }).run()">标题 {{ level - 1 }}</el-button>
      <el-button v-for="[mark, label] in [['bold','加粗'], ['italic','斜体'], ['underline','下划线'], ['strike','删除线']]" :key="mark" size="small" :aria-pressed="editor.isActive(mark)" @mousedown.prevent @click="editor.chain().focus().toggleMark(mark).run()">{{ label }}</el-button>
      <el-button size="small" :aria-pressed="editor.isActive('bulletList')" @mousedown.prevent @click="editor.chain().focus().toggleBulletList().run()">项目列表</el-button>
      <el-button size="small" :aria-pressed="editor.isActive('orderedList')" @mousedown.prevent @click="editor.chain().focus().toggleOrderedList().run()">编号列表</el-button>
      <el-button size="small" :aria-pressed="editor.isActive('blockquote')" @mousedown.prevent @click="editor.chain().focus().toggleBlockquote().run()">引用</el-button>
      <el-button size="small" :disabled="editor.state.selection.empty && !editor.isActive('link')" :aria-pressed="editor.isActive('link')" @mousedown.prevent @click="openLink">链接</el-button>
      <el-button size="small" :disabled="!editor.isActive('link')" @mousedown.prevent @click="editor.chain().focus().extendMarkRange('link').unsetLink().run()">移除链接</el-button>
      <el-button size="small" @mousedown.prevent @click="editor.chain().focus().unsetAllMarks().clearNodes().run()">清除格式</el-button>
      <el-button size="small" :disabled="!editor.can().undo()" @mousedown.prevent @click="editor.chain().focus().undo().run()">撤销</el-button>
      <el-button size="small" :disabled="!editor.can().redo()" @mousedown.prevent @click="editor.chain().focus().redo().run()">重做</el-button>
    </div>
    <EditorContent :editor="editor" />
    <el-dialog v-model="linkDialog" title="插入链接" width="min(480px, 94vw)" append-to-body>
      <el-form label-position="top" @submit.prevent="saveLink">
        <el-form-item label="链接地址" :error="linkError">
          <el-input v-model="linkUrl" placeholder="https://example.com" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="linkDialog = false">取消</el-button>
        <el-button type="primary" @click="saveLink">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>
