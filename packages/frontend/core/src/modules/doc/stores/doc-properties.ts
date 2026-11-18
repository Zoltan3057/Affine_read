/**
 * DocPropertiesStore：文档属性（properties）的数据访问层
 *
 * 这里存的是「不属于文档内容、但也不完全属于文档列表」的属性，例如：
 * primaryMode、pageWidth、edgelessColorTheme、isTemplate、createdBy/updatedBy，
 * 以及自定义属性 `custom:<propertyId>`。
 *
 * 数据有两套来源，读取时需要合并：
 * 1. 旧版（v1）：root Y.Doc 的 `affine:workspace-properties.pageProperties.<docId>`
 *    结构为 { system: {...}, custom: {...} }
 * 2. 新版（v2）：workspace DB 的 `docProperties` 表
 *    （Yjs ORM，每张表一个独立 Y.Doc，guid 为 `db$docProperties`）
 *
 * 合并规则：新版优先；但新版中的 null / undefined 不覆盖旧值。
 *
 * 注意：属性不是文档内容，但同样随工作区同步（v1 在 root Y.Doc，v2 在 DB 的 Y.Doc）。
 */
import {
  LiveData,
  Store,
  yjsGetPath,
  yjsObserveDeep,
} from '@toeverything/infra';
import { isNil, omitBy } from 'lodash-es';
import { combineLatest, map, switchMap } from 'rxjs';
import { AbstractType as YAbstractType } from 'yjs';

import type { WorkspaceDBService } from '../../db';
import type { DocProperties } from '../../db/schema/schema';
import type { WorkspaceService } from '../../workspace';

// v1 数据结构：system 是内置属性，custom 是用户自定义属性
interface LegacyDocProperties {
  custom?: Record<string, { value: unknown } | undefined>;
  system?: Record<string, { value: unknown } | undefined>;
}

export class DocPropertiesStore extends Store {
  constructor(
    // 用于读取旧版属性（root Y.Doc）以及判断工作区类型
    private readonly workspaceService: WorkspaceService,
    // 新版属性存储：workspace DB 的 docProperties 表
    private readonly dbService: WorkspaceDBService
  ) {
    super();
  }

  /**
   * 写入文档属性。
   *
   * 底层 ORM 的 `create` 实际是 upsert（按主键 id 插入或更新），
   * 且 adapter 会跳过值为 undefined 的字段，所以这里可以安全地做部分更新。
   * 写入是同步的，之后由 nbstore 把 db$docProperties 这个 Y.Doc 同步出去。
   */
  updateDocProperties(id: string, config: Partial<DocProperties>) {
    return this.dbService.db.docProperties.create({
      id,
      ...config,
    });
  }

  /**
   * 同步读取合并后的属性。
   *
   * 先展开旧版属性，再展开新版属性；`omitBy(..., isNil)` 让新版中的
   * null / undefined 不覆盖旧值（注意 0 / '' / false 仍然保留）。
   */
  getDocProperties(id: string) {
    return {
      ...this.upgradeLegacyDocProperties(this.getLegacyDocProperties(id)),
      ...omitBy(this.dbService.db.docProperties.get(id), isNil),
      // db always override legacy, but nil value should not override
    };
  }

  /**
   * 响应式读取合并后的属性。
   *
   * combineLatest 同时订阅旧版（root Y.Doc）和新版（DB 表），
   * 任意一边变化都会重新合并并发射。DocRecord.properties$ 就建立在这个流上。
   * 如果两边都没有数据，会得到空对象（不含 id）。
   */
  watchDocProperties(id: string) {
    return combineLatest([
      this.watchLegacyDocProperties(id).pipe(
        map(this.upgradeLegacyDocProperties)
      ),
      this.dbService.db.docProperties.get$(id),
    ]).pipe(
      map(
        ([legacy, db]) =>
          ({
            ...legacy,
            ...omitBy(db, isNil), // db always override legacy, but nil value should not override
          }) as DocProperties
      )
    );
  }

  /**
   * find doc ids by property key and value
   *
   * this apis will not include legacy properties
   *
   * 取某个属性在所有文档上的值，返回 Map<docId, value>。
   * 供搜索、集合规则（collection-rules）等使用；只查新版 DB，不含 v1 旧数据。
   * 没有设置该属性的文档会得到 undefined。
   */
  watchPropertyAllValues(propertyKey: string) {
    return LiveData.from<Map<string, string | undefined>>(
      this.dbService.db.docProperties
        .select$(propertyKey)
        .pipe(map(o => new Map(o.map(i => [i.id, i[propertyKey]])))),
      new Map()
    );
  }

  /**
   * 把 v1 结构转换成扁平的新版结构：
   * - system 里的属性保持原 key
   * - custom 里的属性加 `custom:` 前缀
   * - 值统一转成字符串；null / undefined 跳过
   */
  private upgradeLegacyDocProperties(properties?: LegacyDocProperties) {
    if (!properties) {
      return {};
    }
    const newProperties: Record<string, string> = {};
    for (const [key, info] of Object.entries(properties.system ?? {})) {
      if (info?.value !== undefined && info.value !== null) {
        newProperties[key] = info.value.toString();
      }
    }
    for (const [key, info] of Object.entries(properties.custom ?? {})) {
      if (info?.value !== undefined && info.value !== null) {
        newProperties['custom:' + key] = info.value.toString();
      }
    }
    return newProperties;
  }

  /**
   * 从 root Y.Doc 同步读取 v1 属性。
   * 路径：affine:workspace-properties → pageProperties → <docId>
   */
  private getLegacyDocProperties(id: string) {
    return this.workspaceService.workspace.rootYDoc
      .getMap<any>('affine:workspace-properties')
      .get('pageProperties')
      ?.get(id)
      ?.toJSON() as LegacyDocProperties | undefined;
  }

  /**
   * 响应式读取 v1 属性。
   *
   * yjsGetPath 按路径订阅 `pageProperties.<id>`，再用 yjsObserveDeep
   * 监听该对象内部所有字段的变化；Yjs 类型统一 toJSON 成普通对象。
   */
  private watchLegacyDocProperties(id: string) {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap<any>(
        'affine:workspace-properties'
      ),
      `pageProperties.${id}`
    ).pipe(
      switchMap(yjsObserveDeep),
      map(
        p =>
          (p instanceof YAbstractType ? p.toJSON() : p) as
            | LegacyDocProperties
            | undefined
      )
    );
  }
}
