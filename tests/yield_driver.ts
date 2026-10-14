/// <reference path="./types/lisp-rlm.d.ts" />
// yield_driver.ts — mock-only helper: resumes ANY open yield (data_id + payload passed
// as tx args). Stands in for the MPC network's off-chain signature delivery locally.
export function resume(dataId: string, payload: string): number {
  return near.promiseYieldResume(dataId, payload);
}
