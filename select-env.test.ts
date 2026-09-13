import { describe, expect, it } from 'vitest'
import { selectEnv } from './select-env.mjs'

const P = 'P_'

describe('selectEnv', () => {
  it('selects only the prefixed names', () => {
    expect([...selectEnv({ P_A: '1', P_B: '2', OTHER: '3' }, P)]).toEqual([
      ['P_A', '1'],
      ['P_B', '2'],
    ])
  })

  it('lets an offload key override its base and does not forward it under its own name', () => {
    expect([...selectEnv({ P_TOKENS: 'small', P_OFFLOAD_TOKENS: 'big' }, P)]).toEqual([
      ['P_TOKENS', 'big'],
    ])
  })

  it('applies an offload key even when the base is absent', () => {
    expect([...selectEnv({ P_OFFLOAD_TOKENS: 'big' }, P)]).toEqual([['P_TOKENS', 'big']])
  })

  it('preserves values containing commas and equals signs', () => {
    expect([...selectEnv({ P_X: 'a=b', P_Y: 'a,b,c' }, P)]).toEqual([
      ['P_X', 'a=b'],
      ['P_Y', 'a,b,c'],
    ])
  })

  it('throws when the prefix matches nothing', () => {
    expect(() => selectEnv({ OTHER: '1' }, P)).toThrow(/no variables or secrets match prefix 'P_'/)
  })

  it('throws when a value contains a newline, which the env file cannot represent', () => {
    expect(() => selectEnv({ P_A: 'one\ntwo' }, P)).toThrow(/newline/)
  })
})
