import { OutputArea, OutputAreaModel } from '@jupyterlab/outputarea';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import React, { DependencyList, useLayoutEffect, useRef } from 'react';

import { IOutput } from '../types';

// Models often write LaTeX as \( ... \) / \[ ... \]; Jupyter's markdown renderer expects $ / $$.
function normalizeMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`);
}

/**
 * Show a Lumino widget inside a React element. `create` builds the widget and starts rendering;
 * it is attached first, because JupyterLab renderers only typeset math in attached widgets.
 */
function useLuminoWidget(
  create: (attach: (widget: Widget) => void) => Widget,
  deps: DependencyList
) {
  const ref = useRef<HTMLDivElement>(null);
  // Layout effect: its cleanup runs while the node is still in the document, so Lumino can detach it.
  useLayoutEffect(() => {
    const widget = create(w => {
      if (ref.current?.isConnected) {
        Widget.attach(w, ref.current);
      } else {
        ref.current?.replaceChildren(w.node);
      }
    });
    return () => {
      if (widget.isAttached && widget.node.isConnected) {
        Widget.detach(widget);
      }
      try {
        widget.dispose();
      } catch {
        // Already removed from the page together with its React parent.
      }
    };
  }, deps);
  return ref;
}

/** Markdown rendered exactly like Jupyter markdown cells (sanitized, with math). */
export function Markdown({
  text,
  rendermime
}: {
  text: string;
  rendermime: IRenderMimeRegistry;
}) {
  const ref = useLuminoWidget(
    attach => {
      const renderer = rendermime.createRenderer('text/markdown');
      attach(renderer);
      void renderer.renderModel(
        rendermime.createModel({
          data: { 'text/markdown': normalizeMath(text) }
        })
      );
      return renderer;
    },
    [text, rendermime]
  );
  return <div className="aiss-markdown" ref={ref} />;
}

/** Outputs of executed code (text, tables, plots, errors), rendered like notebook outputs. */
export function Outputs({
  outputs,
  rendermime
}: {
  outputs: IOutput[];
  rendermime: IRenderMimeRegistry;
}) {
  const ref = useLuminoWidget(
    attach => {
      // Untrusted: AI-written code produced these, so HTML is sanitized and scripts don't run.
      const model = new OutputAreaModel({ trusted: false });
      const area = new OutputArea({ model, rendermime });
      area.disposed.connect(() => model.dispose());
      attach(area);
      outputs.forEach(o => model.add(o as any));
      return area;
    },
    [outputs, rendermime]
  );
  return <div className="aiss-outputs" ref={ref} />;
}
