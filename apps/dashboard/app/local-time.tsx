'use client';

import { useEffect, useState } from 'react';

/** UTC from the server, then the viewer's own timezone once the page runs in their browser. */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(`${iso.slice(0, 16).replace('T', ' ')} UTC`);
  useEffect(() => setText(new Date(iso).toLocaleString()), [iso]);
  return <time dateTime={iso}>{text}</time>;
}
