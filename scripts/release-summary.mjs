import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const base=process.argv[2]??git('describe','--tags','--abbrev=0');
const commits=git('log',`--format=%h%x09%s`,`${base}..HEAD`).split(/\r?\n/).filter(Boolean);
const files=git('diff','--name-status','--find-renames',`${base}..HEAD`).split(/\r?\n/).filter(Boolean);
const worktree=git('status','--short').split(/\r?\n/).filter(Boolean);
console.log(`# 发行日志核对草稿\n\n对比基线：${base} → HEAD\n\n## 提交记录（逐项核对）`);
console.log(commits.length?commits.map(value=>`- ${value.replace('\t','：')}`).join('\n'):'- 没有新增提交');
console.log('\n## 变更文件（用于回查，不直接作为用户可见说明）');
console.log(files.length?files.map(value=>`- ${value}`).join('\n'):'- 没有文件差异');
console.log('\n## 当前工作区（包含尚未提交的路径）');
console.log(worktree.length?worktree.map(value=>`- ${value}`).join('\n'):'- 干净');
console.log('\n## 发布说明待填写\n- 新增：\n- 修复：\n- 优化：\n- 升级注意：\n- 验证范围与未覆盖项：');
