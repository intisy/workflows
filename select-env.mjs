#!/usr/bin/env node

export function selectEnv(record, prefix) {
  const override = prefix + 'OFFLOAD_'
  const selected = new Map()
  for (const [name, value] of Object.entries(record)) {
    if (!name.startsWith(prefix) || name.startsWith(override)) continue
    selected.set(name, value)
  }
  for (const [name, value] of Object.entries(record)) {
    if (!name.startsWith(override)) continue
    selected.set(prefix + name.slice(override.length), value)
  }
  if (selected.size === 0) {
    throw new Error(`select-env: no variables or secrets match prefix '${prefix}'`)
  }
  for (const [name, value] of selected) {
    if (String(value).includes('\n')) {
      throw new Error(`select-env: value of ${name} contains a newline, which the env file cannot represent`)
    }
  }
  return selected
}

if (import.meta.filename === process.argv[1]) {
  const [, , prefix, ...sources] = process.argv
  if (!prefix || sources.length === 0) {
    console.error('usage: select-env.mjs PREFIX ENV_VAR_HOLDING_JSON...')
    process.exit(2)
  }
  try {
    const merged = Object.assign({}, ...sources.map((name) => JSON.parse(process.env[name] ?? '{}')))
    for (const [name, value] of selectEnv(merged, prefix)) {
      console.log(`${name}=${value}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
