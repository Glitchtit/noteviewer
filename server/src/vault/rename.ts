export function rewriteLinks(content: string, oldName: string, newName: string): string {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`\\[\\[${escaped}(?=[#|^\\]])`, 'g'), `[[${newName}`);
}
