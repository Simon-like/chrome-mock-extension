/**
 * 命令归约器 —— 纯函数 (store, command) => store
 *
 * 纯函数意味着：
 *   - 不改传入的 store（返回新对象）
 *   - 不做 IO（持久化由宿主层负责）
 *   - 不生成随机值/时间戳（通过 ctx 注入，测试可预测）
 */

import { createResponseSpec, getActiveVariant, materializeRule } from '../store/defaults.js';
import { migrate } from '../store/migrate.js';
import type { Group, MockStore, Project, Rule, Variant } from '../types.js';
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
    // ═══ 规则 ═══
    case 'CREATE_RULE': {
      const rule = materializeRule(cmd.payload.draft, ctx.idFactory, ctx.now());
      return {
        store: { ...store, rules: [...store.rules, rule] },
        result: { ok: true, createdId: rule.id },
      };
    }

    case 'UPDATE_RULE':
      return patchRule(store, cmd.payload.id, ctx, (old) => ({
        ...old,
        ...cmd.payload.patch,
        id: old.id,
      }));

    case 'DELETE_RULE': {
      if (!store.rules.some((r) => r.id === cmd.payload.id)) return notFound(store, cmd.payload.id);
      return {
        store: { ...store, rules: store.rules.filter((r) => r.id !== cmd.payload.id) },
        result: { ok: true },
      };
    }

    case 'DELETE_RULES': {
      const ids = new Set(cmd.payload.ids);
      if (ids.size === 0) return fail(store, '没有选中任何规则');
      const rules = store.rules.filter((r) => !ids.has(r.id));
      if (rules.length === store.rules.length) return fail(store, '选中的规则都不存在');
      return { store: { ...store, rules }, result: { ok: true } };
    }

    case 'TOGGLE_RULES': {
      const ids = new Set(cmd.payload.ids);
      if (ids.size === 0) return fail(store, '没有选中任何规则');
      const now = ctx.now();
      return {
        store: {
          ...store,
          rules: store.rules.map((r) =>
            ids.has(r.id) && r.enabled !== cmd.payload.enabled
              ? { ...r, enabled: cmd.payload.enabled, meta: { ...r.meta, updatedAt: now } }
              : r,
          ),
        },
        result: { ok: true },
      };
    }

    case 'MOVE_RULES': {
      const ids = new Set(cmd.payload.ids);
      if (ids.size === 0) return fail(store, '没有选中任何规则');

      const { projectId, groupId } = cmd.payload;
      if (groupId && !store.groups.some((g) => g.id === groupId)) {
        return fail(store, '目标分组不存在');
      }
      if (projectId && !store.projects.some((p) => p.id === projectId)) {
        return fail(store, '目标项目不存在');
      }

      // 移进某分组时项目跟随该分组，与单条 MOVE_RULE 保持一致
      const groupProject =
        groupId !== undefined && groupId
          ? (store.groups.find((g) => g.id === groupId)?.projectId ?? null)
          : undefined;
      const now = ctx.now();

      return {
        store: {
          ...store,
          rules: store.rules.map((r) => {
            if (!ids.has(r.id)) return r;
            return {
              ...r,
              groupId: groupId !== undefined ? groupId : r.groupId,
              projectId:
                groupProject !== undefined
                  ? groupProject
                  : projectId !== undefined
                    ? projectId
                    : r.projectId,
              meta: { ...r.meta, updatedAt: now },
            };
          }),
        },
        result: { ok: true },
      };
    }

    case 'TOGGLE_RULE':
      return patchRule(store, cmd.payload.id, ctx, (old) => ({
        ...old,
        enabled: cmd.payload.enabled,
      }));

    case 'REORDER_RULE': {
      const from = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (from < 0) return notFound(store, cmd.payload.id);
      const to = clamp(cmd.payload.toIndex, 0, store.rules.length - 1);
      if (from === to) return { store, result: { ok: true } };
      const rules = move(store.rules, from, to);
      return { store: { ...store, rules }, result: { ok: true } };
    }

    case 'DUPLICATE_RULE': {
      const idx = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (idx < 0) return notFound(store, cmd.payload.id);
      const src = store.rules[idx]!;

      // 变体也要换新 id，否则两条规则会共享变体 id，切换时互相干扰
      const idMap = new Map<string, string>();
      const variants: Variant[] = src.variants.map((v) => {
        const nid = ctx.idFactory();
        idMap.set(v.id, nid);
        return { ...deepCopy(v), id: nid };
      });

      const copy: Rule = {
        ...deepCopy(src),
        id: ctx.idFactory(),
        name: `${src.name} 副本`,
        variants,
        activeVariantId: idMap.get(src.activeVariantId) ?? variants[0]!.id,
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

    case 'MOVE_RULE': {
      const from = store.rules.findIndex((r) => r.id === cmd.payload.id);
      if (from < 0) return notFound(store, cmd.payload.id);

      const { projectId, groupId, toIndex } = cmd.payload;
      if (groupId && !store.groups.some((g) => g.id === groupId)) {
        return fail(store, '目标分组不存在');
      }
      if (projectId && !store.projects.some((p) => p.id === projectId)) {
        return fail(store, '目标项目不存在');
      }

      const old = store.rules[from]!;
      const nextGroupId = groupId !== undefined ? groupId : old.groupId;
      // 移进某分组时，项目自动跟随该分组，避免出现「规则在 A 项目的分组里
      // 却标着属于 B 项目」这种自相矛盾的状态
      const groupProject = nextGroupId
        ? (store.groups.find((g) => g.id === nextGroupId)?.projectId ?? null)
        : undefined;

      const moved: Rule = {
        ...old,
        groupId: nextGroupId,
        projectId:
          groupProject !== undefined
            ? groupProject
            : projectId !== undefined
              ? projectId
              : old.projectId,
        meta: { ...old.meta, updatedAt: ctx.now() },
      };

      const rules = [...store.rules];
      rules.splice(from, 1);
      const to = toIndex === undefined ? rules.length : clamp(toIndex, 0, rules.length);
      rules.splice(to, 0, moved);
      return { store: { ...store, rules }, result: { ok: true } };
    }

    // ═══ 变体 ═══
    case 'SET_ACTIVE_VARIANT': {
      const rule = store.rules.find((r) => r.id === cmd.payload.ruleId);
      if (!rule) return notFound(store, cmd.payload.ruleId);
      if (!rule.variants.some((v) => v.id === cmd.payload.variantId)) {
        return fail(store, '变体不存在');
      }
      return patchRule(store, cmd.payload.ruleId, ctx, (old) => ({
        ...old,
        activeVariantId: cmd.payload.variantId,
      }));
    }

    case 'CREATE_VARIANT': {
      const rule = store.rules.find((r) => r.id === cmd.payload.ruleId);
      if (!rule) return notFound(store, cmd.payload.ruleId);

      const variant: Variant = {
        id: ctx.idFactory(),
        name: cmd.payload.name.trim() || `变体 ${rule.variants.length + 1}`,
        // 缺省复制当前变体 —— 多数时候用户是想「基于现在这份改一点」
        response: cmd.payload.response ?? deepCopy(getActiveVariant(rule).response),
      };

      const activate = cmd.payload.activate ?? true;
      const out = patchRule(store, cmd.payload.ruleId, ctx, (old) => ({
        ...old,
        variants: [...old.variants, variant],
        activeVariantId: activate ? variant.id : old.activeVariantId,
      }));
      return { ...out, result: { ...out.result, createdId: variant.id } };
    }

    case 'UPDATE_VARIANT': {
      const rule = store.rules.find((r) => r.id === cmd.payload.ruleId);
      if (!rule) return notFound(store, cmd.payload.ruleId);
      if (!rule.variants.some((v) => v.id === cmd.payload.variantId)) {
        return fail(store, '变体不存在');
      }
      return patchRule(store, cmd.payload.ruleId, ctx, (old) => ({
        ...old,
        variants: old.variants.map((v) =>
          v.id !== cmd.payload.variantId
            ? v
            : {
                ...v,
                name: cmd.payload.patch.name ?? v.name,
                response: cmd.payload.patch.response
                  ? createResponseSpec({ ...v.response, ...cmd.payload.patch.response })
                  : v.response,
              },
        ),
      }));
    }

    case 'DELETE_VARIANT': {
      const rule = store.rules.find((r) => r.id === cmd.payload.ruleId);
      if (!rule) return notFound(store, cmd.payload.ruleId);
      // 变体不能为空 —— 没有变体的规则没有任何响应可返回，是无效状态
      if (rule.variants.length <= 1) return fail(store, '至少要保留一个变体');
      if (!rule.variants.some((v) => v.id === cmd.payload.variantId)) {
        return fail(store, '变体不存在');
      }

      return patchRule(store, cmd.payload.ruleId, ctx, (old) => {
        const variants = old.variants.filter((v) => v.id !== cmd.payload.variantId);
        return {
          ...old,
          variants,
          // 删掉的正是当前生效的，回落到第一个
          activeVariantId:
            old.activeVariantId === cmd.payload.variantId
              ? variants[0]!.id
              : old.activeVariantId,
        };
      });
    }

    case 'REORDER_VARIANT': {
      const rule = store.rules.find((r) => r.id === cmd.payload.ruleId);
      if (!rule) return notFound(store, cmd.payload.ruleId);
      const from = rule.variants.findIndex((v) => v.id === cmd.payload.variantId);
      if (from < 0) return fail(store, '变体不存在');
      const to = clamp(cmd.payload.toIndex, 0, rule.variants.length - 1);
      if (from === to) return { store, result: { ok: true } };
      return patchRule(store, cmd.payload.ruleId, ctx, (old) => ({
        ...old,
        variants: move(old.variants, from, to),
      }));
    }

    // ═══ 项目 ═══
    case 'CREATE_PROJECT': {
      const name = cmd.payload.name.trim();
      if (!name) return fail(store, '项目名不能为空');
      const project: Project = {
        id: ctx.idFactory(),
        name,
        // 默认不限域名 —— 建项目时不必先想清楚域名
        hostScope: { mode: 'include', patterns: [] },
        defaultShellTemplateId: null,
      };
      return {
        store: { ...store, projects: [...store.projects, project], activeProjectId: project.id },
        result: { ok: true, createdId: project.id },
      };
    }

    case 'UPDATE_PROJECT': {
      const idx = store.projects.findIndex((p) => p.id === cmd.payload.id);
      if (idx < 0) return fail(store, '项目不存在');
      const projects = [...store.projects];
      projects[idx] = { ...projects[idx]!, ...cmd.payload.patch, id: cmd.payload.id };
      return { store: { ...store, projects }, result: { ok: true } };
    }

    case 'DELETE_PROJECT': {
      const pid = cmd.payload.id;
      if (!store.projects.some((p) => p.id === pid)) return fail(store, '项目不存在');

      const projects = store.projects.filter((p) => p.id !== pid);
      const activeProjectId = store.activeProjectId === pid ? null : store.activeProjectId;

      if (cmd.payload.cascade === 'cascade') {
        return {
          store: {
            ...store,
            projects,
            groups: store.groups.filter((g) => g.projectId !== pid),
            rules: store.rules.filter((r) => r.projectId !== pid),
            activeProjectId,
          },
          result: { ok: true },
        };
      }

      // 默认 detach：内容降级为全局分组 / 未归档规则。
      // 删错项目还能找回来，删没了找不回来 —— 默认值该选保守的那个
      return {
        store: {
          ...store,
          projects,
          groups: store.groups.map((g) => (g.projectId === pid ? { ...g, projectId: null } : g)),
          rules: store.rules.map((r) => (r.projectId === pid ? { ...r, projectId: null } : r)),
          activeProjectId,
        },
        result: { ok: true },
      };
    }

    case 'SET_ACTIVE_PROJECT': {
      const id = cmd.payload.id;
      if (id && !store.projects.some((p) => p.id === id)) return fail(store, '项目不存在');
      return { store: { ...store, activeProjectId: id }, result: { ok: true } };
    }

    // ═══ 分组 ═══
    case 'CREATE_GROUP': {
      const name = cmd.payload.name.trim();
      if (!name) return fail(store, '分组名不能为空');
      const projectId = cmd.payload.projectId ?? null;
      if (projectId && !store.projects.some((p) => p.id === projectId)) {
        return fail(store, '目标项目不存在');
      }
      const group: Group = {
        id: ctx.idFactory(),
        name,
        projectId,
        collapsed: false,
        defaultShellTemplateId: null,
      };
      return {
        store: { ...store, groups: [...store.groups, group] },
        result: { ok: true, createdId: group.id },
      };
    }

    case 'UPDATE_GROUP': {
      const idx = store.groups.findIndex((g) => g.id === cmd.payload.id);
      if (idx < 0) return fail(store, '分组不存在');
      const groups = [...store.groups];
      const next = { ...groups[idx]!, ...cmd.payload.patch, id: cmd.payload.id };
      groups[idx] = next;

      // 分组换了项目，组内规则要跟着走，否则归属自相矛盾
      const rules =
        cmd.payload.patch.projectId !== undefined
          ? store.rules.map((r) =>
              r.groupId === next.id ? { ...r, projectId: next.projectId } : r,
            )
          : store.rules;

      return { store: { ...store, groups, rules }, result: { ok: true } };
    }

    case 'DELETE_GROUP': {
      const gid = cmd.payload.id;
      if (!store.groups.some((g) => g.id === gid)) return fail(store, '分组不存在');
      const groups = store.groups.filter((g) => g.id !== gid);

      if (cmd.payload.cascade === 'cascade') {
        return {
          store: { ...store, groups, rules: store.rules.filter((r) => r.groupId !== gid) },
          result: { ok: true },
        };
      }

      return {
        store: {
          ...store,
          groups,
          rules: store.rules.map((r) => (r.groupId === gid ? { ...r, groupId: null } : r)),
        },
        result: { ok: true },
      };
    }

    case 'TOGGLE_GROUP': {
      // 分组没有独立开关：这个命令是「批量启用/停用组内规则」。
      // 用户的心智模型就是这个 —— 点分组前的复选框，组内规则全开或全关。
      const target = cmd.payload.id;
      if (target !== null && !store.groups.some((g) => g.id === target)) {
        return fail(store, '分组不存在');
      }
      const now = ctx.now();
      return {
        store: {
          ...store,
          rules: store.rules.map((r) =>
            r.groupId === target && r.enabled !== cmd.payload.enabled
              ? { ...r, enabled: cmd.payload.enabled, meta: { ...r.meta, updatedAt: now } }
              : r,
          ),
        },
        result: { ok: true },
      };
    }

    case 'REORDER_GROUP': {
      const from = store.groups.findIndex((g) => g.id === cmd.payload.id);
      if (from < 0) return fail(store, '分组不存在');
      const to = clamp(cmd.payload.toIndex, 0, store.groups.length - 1);
      if (from === to) return { store, result: { ok: true } };
      return { store: { ...store, groups: move(store.groups, from, to) }, result: { ok: true } };
    }

    // ═══ 全局 ═══
    case 'SET_GLOBAL_ENABLED':
      return { store: { ...store, enabled: cmd.payload.enabled }, result: { ok: true } };

    case 'UPDATE_SETTINGS':
      return {
        store: { ...store, settings: { ...store.settings, ...cmd.payload.patch } },
        result: { ok: true },
      };

    case 'IMPORT_STORE': {
      // 导入的数据可能来自旧版本，必须走 migrate（也顺带做了结构自愈）
      const { store: incoming, reset, reason } = migrate(cmd.payload.raw, ctx.idFactory);
      if (reset) return fail(store, `导入失败：${reason}`);

      if (cmd.payload.mode === 'replace') {
        return { store: incoming, result: { ok: true } };
      }

      // merge：按 id 去重，导入的覆盖同 id 的现有条目
      const rid = new Set(incoming.rules.map((r) => r.id));
      const gid = new Set(incoming.groups.map((g) => g.id));
      const pid = new Set(incoming.projects.map((p) => p.id));
      return {
        store: {
          ...store,
          projects: [...store.projects.filter((p) => !pid.has(p.id)), ...incoming.projects],
          groups: [...store.groups.filter((g) => !gid.has(g.id)), ...incoming.groups],
          rules: [...store.rules.filter((r) => !rid.has(r.id)), ...incoming.rules],
        },
        result: { ok: true },
      };
    }

    case 'RECORD_HIT': {
      const idx = store.rules.findIndex((r) => r.id === cmd.payload.ruleId);
      if (idx < 0) return fail(store, '规则不存在');
      const old = store.rules[idx]!;
      const rules = [...store.rules];
      rules[idx] = {
        ...old,
        meta: { ...old.meta, hitCount: old.meta.hitCount + 1, lastHitAt: cmd.payload.at },
      };
      return { store: { ...store, rules }, result: { ok: true } };
    }

    default: {
      // 穷尽性检查：新增 Command 类型但忘了处理时，这里会报编译错误
      const _exhaustive: never = cmd;
      return fail(store, `未知命令 ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── 辅助 ─────────────────────────────────────────────────

/** 统一的「按 id 找规则并替换」，顺带刷新 updatedAt */
function patchRule(
  store: MockStore,
  id: string,
  ctx: ReduceContext,
  fn: (old: Rule) => Rule,
): ReduceOutcome {
  const idx = store.rules.findIndex((r) => r.id === id);
  if (idx < 0) return notFound(store, id);
  const rules = [...store.rules];
  const next = fn(store.rules[idx]!);
  rules[idx] = { ...next, meta: { ...next.meta, updatedAt: ctx.now() } };
  return { store: { ...store, rules }, result: { ok: true } };
}

function notFound(store: MockStore, id: string): ReduceOutcome {
  return { store, result: { ok: false, error: `规则不存在：${id}` } };
}

function fail(store: MockStore, error: string): ReduceOutcome {
  return { store, result: { ok: false, error } };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), Math.max(min, max));
}

function move<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
