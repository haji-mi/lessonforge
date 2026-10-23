import { describe, expect, it } from 'vitest'
import {
  APP_MODEL_VERSION,
  COMPILER_VERSION,
  PARSER_VERSION,
  PROMPT_SCHEMA_VERSION,
} from '../src/core/version'

describe('P0a smoke', () => {
  it('版本常量就绪', () => {
    expect(APP_MODEL_VERSION).toBeGreaterThan(0)
    expect(PARSER_VERSION).toBeGreaterThan(0)
    expect(COMPILER_VERSION).toBeGreaterThan(0)
    expect(PROMPT_SCHEMA_VERSION).toBeGreaterThan(0)
  })
})
