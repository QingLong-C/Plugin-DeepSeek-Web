import { Ajv, type ValidateFunction, type AnySchema } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'
import { createRequire } from 'node:module'
import { TokenFreeError, record } from '../core/errors.js'
import { strictJson } from '../core/json.js'
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin

/** Local validation of the original schema; never coerce, default or delete arguments. */
export class StrictSchemas {
  private readonly validators = [Ajv, Ajv2019, Ajv2020].map(Validator => {
    const ajv = new Validator({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
      allowUnionTypes: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false,
      addUsedSchema: false, ownProperties: true })
    addFormats(ajv)
    return ajv
  })
  private readonly cache = new Map<string, { validate: ValidateFunction; ajv: Ajv; schema: AnySchema }>()
  prepare(schema: unknown): ValidateFunction {
    try {
      const key = JSON.stringify(schema)
      if (!key || key.length > 262_144) throw new Error('size')
      const existing = this.cache.get(key)
      if (existing) { this.cache.delete(key); this.cache.set(key, existing); return existing.validate }
      const copy = strictJson(key)
      if (!record(copy) && typeof copy !== 'boolean' || record(copy) && Object.hasOwn(copy, '$async')) throw new Error('schema')
      const dialect = record(copy) ? copy.$schema : undefined
      const index = dialect === undefined || dialect === 'http://json-schema.org/draft-07/schema#' || dialect === 'https://json-schema.org/draft-07/schema' ? 0
        : dialect === 'https://json-schema.org/draft/2019-09/schema' ? 1 : dialect === 'https://json-schema.org/draft/2020-12/schema' ? 2 : -1
      const ajv = this.validators[index]
      if (!ajv) throw new Error('dialect')
      const validate = ajv.compile(copy as AnySchema)
      if ('$async' in validate) throw new Error('async')
      this.cache.set(key, { validate: validate as ValidateFunction, ajv, schema: copy as AnySchema })
      if (this.cache.size > 512) {
        const [oldKey, old] = this.cache.entries().next().value!
        old.ajv.removeSchema(old.schema)
        this.cache.delete(oldKey)
      }
      return validate as ValidateFunction
    } catch {
      throw new TokenFreeError('工具或输出规则无法完整校验（不支持的规则、引用、格式或过大的 schema）；未发送网页请求。', 'UNSUPPORTED_SCHEMA')
    }
  }
  check(schema: unknown, value: unknown, code = 'INVALID_TOOL_CALL'): void {
    const validate = this.prepare(schema)
    if (!validate(value)) {
      const issue = validate.errors?.[0]
      // Do not include actual argument values, enum lists or schema contents in errors/logs.
      throw new TokenFreeError(`参数未通过严格格式校验：${issue?.instancePath || '/'}（${issue?.keyword || 'schema'}）；本步骤未执行工具。`, code)
    }
  }
}
