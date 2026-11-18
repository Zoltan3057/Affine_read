import { Service } from '@toeverything/infra';

import { Doc } from '../entities/doc';

export class DocService extends Service {
  // 每次调用产生一个新的、独立的实例（满足“有身份”），同时框架负责它的创建与后续清理（满足“有生命周期”）。
  public readonly doc = this.framework.createEntity(Doc);

  override dispose() {
    this.doc.dispose();
    super.dispose();
  }
}
