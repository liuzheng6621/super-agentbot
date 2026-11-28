/* =========================================================
   AGENTFORGE · 决策信号聚合（纯函数，浏览器与 Node 共用）
   不新增后端字段：把已有状态里「需要人拍板」的信号收敛为决策卡
   ========================================================= */

export function ddClip(value, limit = 96) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function isDegradedDecision(decision, debateStatus = "") {
  return (
    !!decision?.degraded ||
    debateStatus === "fallback" ||
    (!!decision && Number(decision.votes || 0) === 0)
  );
}

export function approvalCommandText(approval) {
  return [approval?.command, ...(approval?.args || [])].filter(Boolean).join(" ");
}

/**
 * 把任务状态里的决策信号聚合为最多 3 张卡。
 * 每张卡只复用已有 API 或纯导航动作，不承诺不存在的后端能力。
 */
export function decisionItems(t, approvals = []) {
  if (!t) return [];
  const items = [];
  const quality = t.quality || {};

  if (t.pendingConfirmation) {
    const est = t.costEstimate || {};
    const range =
      Number.isFinite(Number(est.low)) && Number.isFinite(Number(est.high))
        ? `预计 ${est.low}-${est.high} tokens`
        : "预计超出成本阈值";
    items.push({
      tone: "warn",
      title: `成本超阈值 · ${range}`,
      detail: "确认后团队才会开工；也可以先缩小目标范围再重新发起。",
      actions: [
        { label: "确认开工", action: "confirm", primary: true },
        { label: "查看估算", action: "detail" },
      ],
    });
  }

  const pendingApprovals = (approvals || []).filter((item) => item.status === "pending");
  for (const approval of pendingApprovals.slice(0, 2)) {
    const meta = [approval.reason, approval.agentName ? `申请 ${approval.agentName}` : ""]
      .filter(Boolean)
      .join(" · ");
    items.push({
      tone: "info",
      title: `命令待审批 · ${approvalCommandText(approval)}`,
      detail: meta || "成员申请执行固定白名单命令，需要你批准或拒绝。",
      actions: [
        {
          label: "批准",
          action: "approval",
          decision: "approved",
          approvalId: approval.id,
          primary: true,
        },
        { label: "拒绝", action: "approval", decision: "rejected", approvalId: approval.id },
      ],
    });
  }

  if (quality.status === "failed") {
    items.push({
      tone: "err",
      title: "质量门未通过",
      detail: quality.reason || "测试或评审未通过，交付不会被判定为完成。",
      actions: [{ label: "查看失败详情", action: "detail", primary: true }],
    });
  }

  if (quality.status === "no-test-entry") {
    items.push({
      tone: "warn",
      title: "没有可执行的测试入口",
      detail: "质量门拿不到 pass 证据，交付不会被判定为通过。",
      actions: [{ label: "查看工序", action: "detail" }],
    });
  }

  const decision = t.debate?.decision;
  const diversity = decision?.diversity;
  const degraded = isDegradedDecision(decision, t.debate?.status);
  if (decision && (degraded || (diversity && !diversity.sufficient))) {
    const reason =
      (diversity?.issues || []).map((issue) => issue.message).join("；") ||
      decision.reason ||
      "讨论未形成有效交叉评分";
    items.push({
      tone: "info",
      title: degraded ? "方案讨论降级裁决" : "方案多样性不足",
      detail: reason,
      actions: [{ label: "查看方案对比", action: "debate", primary: true }],
    });
  }

  if (quality.selfReview) {
    items.push({
      tone: "warn",
      title: "评审独立性有限",
      detail: `评审与实现同模型（${quality.reviewerModel || "未配置"}），结论建议人工复核。`,
      actions: [{ label: "查看评审", action: "detail" }],
    });
  }

  if (t.waitingReason) {
    items.push({
      tone: "info",
      title: "团队正在等待",
      detail: t.waitingReason,
      actions: [{ label: "查看链路", action: "detail" }],
    });
  }

  return items.slice(0, 3);
}
