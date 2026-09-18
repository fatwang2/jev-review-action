export const MARKER = '<!-- jev-review-action:v1 -->';
export const markdown = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;').replace(/[\r\n]/g, ' ').replace(/([\\`*_{}\[\]()#+.!|~])/g, '\\$1');

export function renderComment(report) {
  const titles = { recommended: 'Recommended for maintainer review', 'needs-review': 'Needs maintainer review', 'not-recommended': 'Not recommended by the configured policy', error: 'Review could not be completed', skipped: 'No submission to evaluate' };
  const lines = [MARKER, '## Jev review', '', `**${titles[report.decision] ?? 'Needs review'}**`, ''];
  if (report.category) lines.push(`Suggested category: **${markdown(report.category)}** · category confidence: ${report.categoryConfidence.toFixed(2)}`, '');
  if (report.checks?.length) {
    lines.push('| Criterion | Probability of yes | Result |', '| --- | ---: | --- |');
    for (const c of report.checks) lines.push(`| ${markdown(c.title)} | ${c.probability.toFixed(2)} | ${c.status} |`);
    lines.push('');
  }
  if (report.reasons?.length) {
    lines.push('Follow-up:', '');
    for (const reason of report.reasons.slice(0, 20)) lines.push(`- ${markdown(reason)}`);
    lines.push('');
  }
  if (report.evidence?.length) {
    lines.push('Evidence inspected:', '');
    for (const source of report.evidence) lines.push(`- [${markdown(source.path)}](${source.url})${source.truncated ? ' (excerpt)' : ''}`);
    lines.push('');
  }
  if (report.headSha) lines.push(`PR commit: \`${report.headSha}\``);
  if (report.model) lines.push(`Model: \`${markdown(report.model)}\` · policy: \`${report.policyHash.slice(0, 12)}\` · input tokens: ${report.usage.input_tokens}`);
  if (report.runUrl) lines.push(`[Review run and JSON report](${report.runUrl})`);
  lines.push('', 'Model judgments use Jev only; this comment is generated from a template. Probabilities are model judgments, not verified accuracy. A maintainer decides whether to merge.');
  return lines.join('\n');
}
