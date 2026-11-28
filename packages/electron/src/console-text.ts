/** The text of a console call, from the arguments the DevTools protocol reports it with. */

import type { Protocol } from 'devtools-protocol';

/** A console call's arguments as one line, the way a terminal would print them. */
export function consoleText(args: readonly Protocol.Runtime.RemoteObject[]): string {
  return args.map(argumentText).join(' ');
}

function argumentText(arg: Protocol.Runtime.RemoteObject): string {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.type === 'string') return String(arg.value);
  if (arg.type === 'undefined') return 'undefined';
  if (arg.type !== 'object' && arg.type !== 'function') return String(arg.value);
  if (arg.subtype === 'null') return 'null';
  // An error prints as its stack does; a plain object or array as the preview the protocol sends with it.
  if (arg.subtype === 'error' || arg.preview === undefined) return arg.description ?? arg.type;
  return previewText(arg.preview);
}

function previewText(preview: Protocol.Runtime.ObjectPreview): string {
  const more = preview.overflow ? ', …' : '';
  if (preview.subtype === 'array') return `[${preview.properties.map((property) => property.value ?? property.type).join(', ')}${more}]`;
  return `{${preview.properties.map((property) => `${property.name}: ${property.value ?? property.type}`).join(', ')}${more}}`;
}
