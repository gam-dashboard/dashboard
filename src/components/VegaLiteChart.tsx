import React, { useEffect, useRef } from 'react'; import embed, { VisualizationSpec } from 'vega-embed';

type Props = { spec: VisualizationSpec; };

export default function VegaLiteChart({ spec }: Props) { const ref = useRef<HTMLDivElement | null>(null);

useEffect(() => { if (!ref.current) return; let cancelled = false; embed(ref.current, spec, { actions: true }) .catch((err) => { if (!cancelled) console.error('vega-embed error', err); }); return () => { cancelled = true; if (ref.current) ref.current.innerHTML = ''; }; }, [spec]);

return <div ref={ref} />; }