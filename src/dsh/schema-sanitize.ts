/** Compatibility projection into the DSH schema subset.
 * Unsupported constraints are omitted here; the tool implementation remains
 * responsible for its full input validation. This is not lossless validation.
 */
/** 宿主接受的约束关键字。 */
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);

/** 宿主接受的注解关键字。 */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 剥掉宿主不接受的约束/注解关键字，保留 properties 的属性名与子 schema。 */
function stripNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((entry) => stripNode(entry));
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      // properties 是「属性名 → 子 schema」映射：属性名不是关键字，逐个保留。
      const properties: Record<string, unknown> = {};
      if (isPlainObject(value)) {
        for (const [name, child] of Object.entries(value)) properties[name] = stripNode(child);
      }
      out.properties = properties;
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      // 宿主不接受 type 数组（联合类型），也不接受 oneOf 与 items 并列。
      //
      // 「任意 JSON」这类联合类型在宿主白名单里无法忠实表达：宿主既没有 "any"，
      // 也不能让 oneOf 与 items 并列。因此这里退化为空 schema `{}`——
      // 空 schema 表示不施加任何约束，与"任意 JSON"语义一致，
      // 而不是把类型收窄成某个具体类型（那会改变校验语义）。
      const types = value.filter((entry) => typeof entry === 'string');
      if (types.length === 0) continue;
      const arrayItems = isPlainObject(node.items) ? node.items : undefined;
      const branches = types.map((entry) => (
        entry === 'array' && arrayItems
          ? { type: 'array', items: stripNode(arrayItems) }
          : { type: entry }
      ));
      const isAnyJson = types.length > 1 && types.length === 6
        && ['null', 'boolean', 'object', 'array', 'number', 'string']
          .every((entry) => types.includes(entry));

      if (isAnyJson) {
        // 任意 JSON 值：退化为无约束的空 schema。
        if (arrayItems) {
          // 外层是数组：保留数组外壳，元素不约束。
          out.type = 'array';
          out.items = {};
        } else {
          for (const k of Object.keys(out)) delete out[k];
          return {};
        }
        continue;
      }
      if (branches.length === 1) {
        const only = branches[0]!;
        if (only.type === 'array' && only.items !== undefined) {
          out.type = 'array';
          out.items = only.items;
        } else {
          out.type = only.type;
        }
      } else {
        // 多分支：宿主要求 oneOf 旁边不能有 items，items 已并入 array 分支。
        out.oneOf = branches;
      }
      continue;
    }
    if (key === 'additionalProperties' && isPlainObject(value)) {
      // 宿主的 additionalProperties 只接受 boolean，无法表达"额外属性须为某类型"。
      // 对象形式 → true：允许额外属性（不约束其取值类型）。
      // 此处无法执行值类型约束，原工具执行端仍须校验。
      out.additionalProperties = true;
      continue;
    }
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) {
      out[key] = stripNode(value);
    }
  }
  // Every branch already enforces this type, so the sibling type is redundant.
  // Removing only the duplicate declaration preserves oneOf's exact-match rule.
  if (typeof out.type === 'string' && Array.isArray(out.oneOf) && out.oneOf.length > 0
    && out.oneOf.every((branch) => isPlainObject(branch) && branch.type === out.type)) {
    delete out.type;
  }
  return out;
}

/**
 * 把一个 schema 归一化到宿主接受的白名单子集。
 * 返回新对象，不修改入参。
 */
export function sanitizeJsonSchema(value: unknown): unknown {
  return stripNode(value);
}
