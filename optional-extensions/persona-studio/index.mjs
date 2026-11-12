import {generate, studio, draftSchema,validateDraft,markdown} from './lib/studio.mjs';

export function setup(api) {
  api.registerAction({
    id:'preview',
    description:'本机页面校验和预览已编辑的人格草稿，不调用模型，不保存或启用。',
    parameters:{type:'object',properties:{draft:draftSchema},required:['draft'],additionalProperties:false},
    execute:async(_ctx,{draft})=>{const value=validateDraft(draft);return {draft:value,preview:markdown(value),filename:value.display_name+'.md',saved:false,applied:false};}
  });
  api.registerTool({
    id: 'draft',
    description: '仅在用户明确要求设计或修改 AI 人格时使用。先用 view 读取草稿及 revision，再根据用户描述起草完整 draft，调用 save（expectedRevision 填读取值）。draft 包含身份、语气、互动边界和示例，多轮修改保留未要求改变的设定。工具仅保存设计文本，不改变当前人格。不要把普通聊天当作人格修改。',
    parameters: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['view', 'save', 'export', 'reset']},
        draft: draftSchema,
        expectedRevision: {type: 'integer', minimum: 0},
        confirm: {type: 'boolean'}
      },
      required: ['action'], additionalProperties: false
    },
    execute: studio
  });
  api.registerAction({
    id: 'generate',
    description: '本机页面专用：用当前已配置模型设计或修改人格，返回预览，不保存、不启用。最多 25 秒，使用模型额度。',
    parameters: {
      type: 'object', properties: {
        message: {type: 'string', minLength: 1, maxLength: 3000},
        draft: draftSchema
      }, required: ['message'], additionalProperties: false
    },
    execute: generate
  });
}
