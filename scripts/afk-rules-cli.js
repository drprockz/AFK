#!/usr/bin/env node
// scripts/afk-rules-cli.js
import { listRules, addRule, removeRule } from '../src/engine/rules.js'

const [,, subcmd, ...rest] = process.argv

if (!subcmd) {
  // list all rules — show full IDs so users can copy-paste for `remove`
  const rules = listRules(null)
  if (rules.length === 0) { process.stdout.write('No rules defined.\n'); process.exit(0) }
  process.stdout.write('\nRules:\n')
  process.stdout.write('  ' + ['ID (full)', 'Tool', 'Pattern', 'Action', 'Priority', 'Label'].join('\t') + '\n')
  rules.forEach(r => {
    process.stdout.write(`  ${r.id}\t${r.tool}\t${r.pattern}\t${r.action}\t${r.priority}\t${r.label || ''}\n`)
  })
  process.stdout.write('\n')

} else if (subcmd === 'project') {
  const rules = listRules(process.cwd())
  if (rules.length === 0) { process.stdout.write('No rules scoped to this project.\n'); process.exit(0) }
  rules.forEach(r => process.stdout.write(`  ${r.id} | ${r.tool} | ${r.pattern} | ${r.action}\n`))

} else if (subcmd === 'add') {
  // parse key=value args
  const kv = {}
  rest.forEach(arg => {
    const eqIdx = arg.indexOf('=')
    if (eqIdx === -1) return
    kv[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1)
  })
  if (!kv.tool || !kv.pattern || !kv.action) {
    process.stderr.write('Usage: afk:rules add tool=<t> pattern=<p> action=allow|deny [label=<l>] [priority=<n>]\n')
    process.exit(1)
  }
  // Validate priority is a valid integer
  let priority = 0
  if (kv.priority !== undefined) {
    priority = parseInt(kv.priority, 10)
    if (isNaN(priority)) {
      process.stderr.write(`priority must be an integer, got: ${kv.priority}\n`)
      process.exit(1)
    }
  }
  try {
    const id = addRule({
      tool:     kv.tool,
      pattern:  kv.pattern,
      action:   kv.action,
      label:    kv.label     || undefined,
      priority
    })
    process.stdout.write(`Created rule ${id}\n`)
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
  }

} else if (subcmd === 'remove') {
  const id = rest[0]
  if (!id) { process.stderr.write('Usage: afk:rules remove <full-uuid>\n'); process.exit(1) }
  const changes = removeRule(id)
  if (!changes) { process.stderr.write(`No rule found with id: ${id}\n`); process.exit(1) }
  process.stdout.write(`Deleted rule ${id}\n`)

} else {
  process.stderr.write(`Unknown subcommand: ${subcmd}\n`)
  process.exit(1)
}
