// scripts/setup.js
// Post-install: create ~/.claude/afk/ directory and initialize database
import { getDb } from '../src/store/db.js'
import { writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const afkDir = join(homedir(), '.claude', 'afk')
const configPath = join(afkDir, 'config.json')

getDb() // triggers mkdir + schema creation

if (!existsSync(configPath)) {
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    afk: { autoAfkMinutes: 15, autoReturn: true },
    thresholds: { autoApprove: 0.85, autoDeny: 0.15, anomalyFlag: 0.7 },
    safety: { snapshotBeforeDestructive: true, alwaysInterruptSensitive: true, failClosed: true },
    notifications: { provider: null, timeout: 120, dashboardTimeout: 300, onlyFor: ['high', 'critical'] },
    dashboard: { port: 6789, autoOpen: true },
    digest: { enabled: true, showOnAfkOff: true }
  }, null, 2))
}

process.stderr.write('afk: setup complete\n')
