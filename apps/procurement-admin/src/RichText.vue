<script setup lang="ts">
import { EditorContent, useEditor, type JSONContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
const props = defineProps<{ modelValue: JSONContent; readonly?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [JSONContent] }>();
const editor = useEditor({
  extensions: [StarterKit],
  content: props.modelValue,
  editable: !props.readonly,
  editorProps: {
    attributes: {
      "aria-label": "采购说明",
      role: "textbox",
      "aria-multiline": "true",
    },
  },
  onUpdate: (event) => emit("update:modelValue", event.editor.getJSON()),
});
</script>
<template>
  <div class="rich">
    <div class="tools" v-if="editor && !readonly">
      <el-button
        size="small"
        :aria-pressed="editor.isActive('bold')"
        @click="editor.chain().focus().toggleBold().run()"
      >
        加粗
      </el-button>
      <el-button
        size="small"
        @click="editor.chain().focus().toggleItalic().run()"
      >
        斜体
      </el-button>
      <el-button
        size="small"
        @click="editor.chain().focus().toggleBulletList().run()"
      >
        项目列表
      </el-button>
    </div>
    <EditorContent :editor="editor" />
  </div>
</template>
