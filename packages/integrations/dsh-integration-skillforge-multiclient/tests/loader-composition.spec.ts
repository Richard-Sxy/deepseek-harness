import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import SkillForgeMulticlientService from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('SkillForge multi-client through a real Loader composition', () => {
  it('loads the default Service export with its declared dependencies', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-skillforge-multiclient-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-dependencies',
      "- name: '@deepseek-ai/dsh-integration-skillforge-multiclient'",
      '  config:',
      "    defaultScope: 'loader-test'",
      '',
    ].join('\n'))

    const tables = new Map<string, Map<string, unknown>>()
    const table = (name: string) => {
      const records = new Map<string, unknown>()
      tables.set(name, records)
      return {
        get: (key: string) => records.get(key),
        entries: () => records.entries(),
        keys: () => records.keys(),
        get size() { return records.size },
        put: async (key: string, value: unknown) => { records.set(key, value) },
        delete: async (key: string) => records.delete(key),
      }
    }
    const dependencies = {
      name: 'fixture-dependencies',
      apply(ctx: Context) {
        ctx.provide('storageDomain', {
          open: async () => ({ table, close: async () => {} }),
        } as never)
        ctx.provide('systemPrompt', { section: () => () => {} } as never)
      },
    }

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['fixture-dependencies', dependencies],
      ['@deepseek-ai/dsh-integration-skillforge-multiclient', SkillForgeMulticlientService],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>

    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.get('skillforgeMulticlient')).toBeInstanceOf(SkillForgeMulticlientService)
    expect(tables.size).toBe(4)
  })
})
