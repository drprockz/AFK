#!/usr/bin/env node
// scripts/afk-rules-cli.js
import { listRules, addRule, removeRule } from '../src/engine/rules.js'

const [,, subcmd, ...rest] = process.argv

if (!subcmd) {
  // list all rules
  const rules = listRules(null)
  if (rules.length === 0) { console.log('No rules defined.'); process.exit(0) }
  console.log('\nRules:')
  console.log('  ' + ['ID', 'Tool', 'Pattern', 'Action', 'Priority', 'Label'].join('\t'))
  rules.forEach(r => {
    console.log(`  ${r.id.slice(0,8)}\t${r.tool}\t${r.pattern}\t${r.action}\t${r.priority}\t${r.label || ''}`)
  })
  console.log()

} else if (subcmd === 'project') {
  const rules = listRules(process.cwd())
  if (rules.length === 0) { console.log('No rules scoped to this project.'); process.exit(0) }
  rules.forEach(r => console.log(`  ${r.id.slice(0,8)} | ${r.tool} | ${r.pattern} | ${r.action}`))

} else if (subcmd === 'add') {
  // parse key=value args — iterate rest directly to preserve values with spaces
  // e.g. pattern="npm run *" arrives as one argv item after shell unquoting: "pattern=npm run *"
  const kv = {}
  rest.forEach(arg => {
    const eqIdx = arg.indexOf('=')
    if (eqIdx === -1) return
    kv[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1)
  })
  if (!kv.tool || !kv.pattern || !kv.action) {
    console.error('Usage: afk:rules add tool=<t> pattern=<p> action=allow|deny [label=<l>] [priority=<n>]')
    process.exit(1)
  }
  if (kv.action !== 'allow' && kv.action !== 'deny') {
    console.error('action must be allow or deny')
    process.exit(1)
  }
  const id = addRule({
    tool:     kv.tool,
    pattern:  kv.pattern,
    action:   kv.action,
    label:    kv.label     || undefined,
    priority: kv.priority  ? Number(kv.priority) : 0
  })
  console.log(`Created rule ${id}`)

} else if (subcmd === 'remove') {
  const id = rest[0]
  if (!id) { console.error('Usage: afk:rules remove <id>'); process.exit(1) }
  const changes = removeRule(id)
  if (!changes) { console.error(`No rule found with id: ${id}`); process.exit(1) }
  console.log(`Deleted rule ${id}`)

} else {
  console.error(`Unknown subcommand: ${subcmd}`)
  process.exit(1)
}
