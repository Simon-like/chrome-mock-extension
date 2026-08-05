/**
 * 命令归约器 —— 纯函数 (store, command) => store
 *
 * 纯函数意味着：
 *   - 不改传入的 store（返回新对象）
 *   - 不做 IO（持久化由宿主层负责）
 *   - 不生成随机值/时间戳（通过 ctx 注入，测试可预测）
 *
 * 详见设计文档 05 §3.4。
 */

import { materializeRule } from '../store/defaults.js';
import { migrate } from '../store/migrate.js';
import type { Group, MockStore, Rule } from '../types.js';
import type { Command, CommandResult } from './types.js';

/** 副作用注入点：让 reducer 保持纯函数，同时测试可控 */
export interface ReduceContext {
  idFactory: () => string;
  now: () => number;
}

export interface ReduceOutcome {
  store: MockStore;
  result: CommandResult;
}

export function reduce(
  store: MockStore,
  cmd: Command,
  ctx: ReduceContext,
): ReduceOutcome {
  switch (cmd.type) {
    case 'CREATE_RULE': {
      const rule = materializeRule(cmd.payload.draft, ctx.idFactory, ctx.now());
      return {
        store: { ...store, rules: [...store.rules, rule] },
        result: { ok: true, createdId: rule.id },
      };
    }

    case 'UPDATE_RULE': {
      const idx = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (idx < 0) return notFound(store, cmd.payload.id);
      const old = store.rules[idx]!;
      const next: Rule = {
        ...old,
        ...cmd.payload.patch,
        id: old.id,
        meta: { ...old.meta, updatedAt: ctx.now() },
      };
      return { store: replaceAt(store, idx, next), result: { ok: true } };
    }

    case 'DELETE_RULE': {
      const exists = store.rules.some((r) => r.id === cmd.payload.id);
      if (!exists) return notFound(store, cmd.payload.id);
      return {
        store: { ...store, rules: store.rules.filter((r) => r.id !== cmd.payload.id) },
        result: { ok: true },
      };
    }

    case 'TOGGLE_RULE': {
      const idx = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (idx < 0) return notFound(store, cmd.payload.id);
      const old = store.rules[idx]!;
      const next: Rule = {
        ...old,
        enabled: cmd.payload.enabled,
        meta: { ...old.meta, updatedAt: ctx.now() },
      };
      return { store: replaceAt(store, idx, next), result: { ok: true } };
    }

    case 'REORDER_RULE': {
      // 顺序即优先级（先到先得），所以拖拽排序是个真实的业务操作
      const from = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (from < 0) return notFound(store, cmd.payload.id);
      const to = clamp(cmd.payload.toIndex, 0, store.rules.length - 1);
      if (from === to) return { store, result: { ok: true } };

      const rules = [...store.rules];
      const [moved] = rules.splice(from, 1);
      rules.splice(to, 0, moved!);
      return { store: { ...store, rules }, result: { ok: true } };
    }

    case 'DUPLICATE_RULE': {
      const idx = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (idx < 0) return notFound(store, cmd.payload.id);
      const src = store.rules[idx]!;
      const copy: Rule = {
        ...structuredCopy(src),
        id: ctx.idFactory(),
        name: `${src.name} 副本`,
        meta: {
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
          source: src.meta.source,
          hitCount: 0,
          lastHitAt: null,
        },
      };
      const rules = [...store.rules];
      rules.splice(idx + 1, 0, copy);
      return { store: { ...store, rules }, result: { ok: true, createdId: copy.id } };
    }

    case 'MOVE_RULE_TO_GROUP': {
      const from = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (from < 0) return notFound(store, cmd.payload.id);
      if (cmd.payload.groupId && !store.groups.some((g) => g.id === cmd.payload.groupId)) {
        return { store, result: { ok: false, error: '目标分组不存在' } };
      }

      const old = store.rules[from]!;
      const moved: Rule = {
        ...old,
        groupId: cmd.payload.groupId,
        meta: { ...old.meta, updatedAt: ctx.now() },
      };

      const rules = [...store.rules];
      rules.splice(from, 1);
      // toIndex 是在【移除后】数组里的目标位置
      const to =
        cmd.payload.toIndex === undefined
          ? rules.length
          : clamp(cmd.payload.toIndex, 0, rules.length);
      rules.splice(to, 0, moved);
      return { store: { ...store, rules }, result: { ok: true } };
    }

    case 'CREATE_GROUP': {
      const name = cmd.payload.name.trim();
      if (!name) return { store, result: { ok: false, error: '分组名不能为空' } };
      const group: Group = {
        id: ctx.idFactory(),
        name,
        enabled: true,
        exclusive: cmd.payload.exclusive ?? false,
        collapsed: false,
        defaultShellTemplateId: null,
      };
      // 新建的互斥组默认启用，同样要遵守互斥规则
      const groups = group.exclusive
        ? [...closeOtherExclusive(store.groups, group.id), group]
        : [...store.groups, group];
      return { store: { ...store, groups }, result: { ok: true, createdId: group.id } };
    }

    case 'UPDATE_GROUP': {
      const idx = store.groups.findIndex((g) => g.id === cmd.payload.id);
      if (idx < 0) return { store, result: { ok: false, error: '分组不存在' } };
      const old = store.groups[idx]!;
      const next: Group = { ...old, ...cmd.payload.patch, id: old.id };

      let groups = [...store.groups];
      groups[idx] = next;
      // 普通组改成互斥组时，若它是启用的，要把其他互斥组关掉
      if (!old.exclusive && next.exclusive && next.enabled) {
        groups = closeOtherExclusive(groups, next.id);
      }
      return { store: { ...store, groups }, result: { ok: true } };
    }

    case 'DELETE_GROUP': {
      if (!store.groups.some((g) => g.id === cmd.payload.id)) {
        return { store, result: { ok: false, error: '分组不存在' } };
      }
      return {
        store: {
          ...store,
          groups: store.groups.filter((g) => g.id !== cmd.payload.id),
          // 组内规则不删除，移到未分组 —— 删组不该顺带毁掉规则
          rules: store.rules.map((r) =>
            r.groupId === cmd.payload.id ? { ...r, groupId: null } : r,
          ),
        },
        result: { ok: true },
      };
    }

    case 'TOGGLE_GROUP': {
      const idx = store.groups.findIndex((g) => g.id === cmd.payload.id);
      if (idx < 0) return { store, result: { ok: false, error: '分组不存在' } };
      const target = store.groups[idx]!;

      let groups = [...store.groups];
      groups[idx] = { ...target, enabled: cmd.payload.enabled };

      // 场景切换的核心：启用一个互斥组，其余互斥组自动关闭
      if (target.exclusive && cmd.payload.enabled) {
        groups = closeOtherExclusive(groups, target.id);
      }
      return { store: { ...store, groups }, result: { ok: true } };
    }

    case 'REORDER_GROUP': {
      const from = store.groups.findIndex((g) => g.id === cmd.payload.id);
      if (from < 0) return { store, result: { ok: false, error: '分组不存在' } };
      const to = clamp(cmd.payload.toIndex, 0, store.groups.length - 1);
      if (from === to) return { store, result: { ok: true } };
      const groups = [...store.groups];
      const [moved] = groups.splice(from, 1);
      groups.splice(to, 0, moved!);
      return { store: { ...store, groups }, result: { ok: true } };
    }

    case 'SET_GLOBAL_ENABLED':
      return {
        store: { ...store, enabled: cmd.payload.enabled },
        result: { ok: true },
      };

    case 'UPDATE_SETTINGS':
      return {
        store: { ...store, settings: { ...store.settings, ...cmd.payload.patch } },
        result: { ok: true },
      };

    case 'IMPORT_STORE': {
      // 导入的数据可能来自旧版本，必须走 migrate（也顺带做了结构自愈）
      const { store: incoming, reset, reason } = migrate(cmd.payload.raw);
      if (reset) {
        return { store, result: { ok: false, error: `导入失败：${reason}` } };
      }
      if (cmd.payload.mode === 'replace') {
        return { store: incoming, result: { ok: true } };
      }
      // merge：按 id 去重，导入的覆盖同 id 的现有规则
      const incomingIds = new Set(incoming.rules.map((r) => r.id));
      const kept = store.rules.filter((r) => !incomingIds.has(r.id));
      return {
        store: { ...store, rules: [...kept, ...incoming.rules] },
        result: { ok: true },
      };
    }

    case 'RECORD_HIT': {
      const idx = store.rules.findIndex((r) => r.id === cmd.payload.ruleId);
      if (idx < 0) return { store, result: { ok: false, error: '规则不存在' } };
      const old = store.rules[idx]!;
      const next: Rule = {
        ...old,
        meta: {
          ...old.meta,
          hitCount: old.meta.hitCount + 1,
          lastHitAt: cmd.payload.at,
        },
      };
      return { store: replaceAt(store, idx, next), result: { ok: true } };
    }

    default: {
      // 穷尽性检查：新增 Command 类型但忘了处理时，这里会报编译错误
      const _exhaustive: never = cmd;
      return { store, result: { ok: false, error: `未知命令 ${JSON.stringify(_exhaustive)}` } };
    }
  }
}

function replaceAt(store: MockStore, idx: number, rule: Rule): MockStore {
  const rules = [...store.rules];
  rules[idx] = rule;
  return { ...store, rules };
}

function notFound(store: MockStore, id: string): ReduceOutcome {
  return { store, result: { ok: false, error: `规则不存在：${id}` } };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * 互斥组的核心规则：把除 keepId 之外的所有互斥组关掉。
 *
 * 抽成函数是因为有三个入口会触发它（切换组、新建互斥组、把普通组改成互斥组），
 * 散落在各处容易漏掉其中一个。
 */
function closeOtherExclusive(groups: Group[], keepId: string): Group[] {
  return groups.map((g) =>
    g.exclusive && g.id !== keepId && g.enabled ? { ...g, enabled: false } : g,
  );
}

function structuredCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
