import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { LabIcon } from '@jupyterlab/ui-components';

import { Sidebar } from './components/Sidebar';
import { NotebookController } from './controller';
import {
  convertToQuestion,
  getMeta,
  insertQuestion,
  questionOf
} from './notebook';
import { Store } from './store';
import { QuestionType } from './types';

const PLUGIN_ID = 'aissignment:plugin';

const icon = new LabIcon({
  name: 'aissignment:icon',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161">' +
    '<path d="M12 3 1 9l11 6 9-4.9V17h2V9L12 3zm-6.8 9.6v3.9L12 20l6.8-3.5v-3.9L12 16.3l-6.8-3.7z"/></g></svg>'
});

const CommandIds = {
  insertText: 'aissignment:insert-text-question',
  insertMcq: 'aissignment:insert-mcq-question',
  insertCode: 'aissignment:insert-code-question',
  convert: 'aissignment:convert-to-question',
  runAll: 'aissignment:run-all',
  export: 'aissignment:export',
  clearAnswers: 'aissignment:clear-answers',
  clearSuggestions: 'aissignment:clear-suggestions'
};

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Write assignments in Jupyter and preview what an AI-only student would hand in',
  autoStart: true,
  requires: [INotebookTracker, IRenderMimeRegistry, ILabShell],
  optional: [ISettingRegistry, ICommandPalette, ILayoutRestorer],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    rendermime: IRenderMimeRegistry,
    shell: ILabShell,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null
  ) => {
    const store = new Store();
    void store.loadConfig();
    if (settingRegistry) {
      void store.connectSettings(settingRegistry, PLUGIN_ID);
    }

    const controllers = new WeakMap<NotebookPanel, NotebookController>();
    const attach = (panel: NotebookPanel) => {
      if (!controllers.has(panel)) {
        controllers.set(
          panel,
          new NotebookController(panel, store, rendermime)
        );
      }
    };
    tracker.forEach(attach);
    tracker.widgetAdded.connect((_, panel) => attach(panel));
    const current = () =>
      tracker.currentWidget
        ? controllers.get(tracker.currentWidget)
        : undefined;

    const insert = (type: QuestionType | 'convert') => {
      const panel = tracker.currentWidget;
      const model = panel?.model;
      if (!panel || !model) {
        return;
      }
      const notebook = panel.content;
      const active = notebook.activeCellIndex;
      if (type === 'convert') {
        convertToQuestion(model, active, 'text');
        notebook.activeCellIndex = active;
        return;
      }
      // Below the active cell; if it belongs to a question, below the question's last cell.
      let index = active + 1;
      const activeCell = model.cells.get(active);
      const q = activeCell && questionOf(model, activeCell);
      if (q) {
        const last = q.tests ?? q.answer ?? q.prompt;
        for (let i = 0; i < model.cells.length; i++) {
          if (model.cells.get(i) === last) {
            index = i + 1;
          }
        }
      }
      insertQuestion(model, Math.min(index, model.cells.length), type);
      notebook.activeCellIndex = index;
      notebook.mode = 'edit';
    };

    const hasNotebook = () => !!tracker.currentWidget;
    app.commands.addCommand(CommandIds.insertText, {
      label: 'Insert Text Question',
      caption: 'Insert a question cell and its reference answer cell',
      isEnabled: hasNotebook,
      execute: () => insert('text')
    });
    app.commands.addCommand(CommandIds.insertMcq, {
      label: 'Insert Multiple-Choice Question',
      isEnabled: hasNotebook,
      execute: () => insert('mcq')
    });
    app.commands.addCommand(CommandIds.insertCode, {
      label: 'Insert Code Question',
      caption:
        'Insert a question cell, a reference solution cell and a tests cell',
      isEnabled: hasNotebook,
      execute: () => insert('code')
    });
    app.commands.addCommand(CommandIds.convert, {
      label: 'Make Cell an Assignment Question',
      isEnabled: () =>
        tracker.activeCell?.model.type === 'markdown' &&
        !getMeta(tracker.activeCell.model).role,
      execute: () => insert('convert')
    });
    app.commands.addCommand(CommandIds.runAll, {
      label: 'Run AI Students on All Questions',
      isEnabled: hasNotebook,
      execute: () => current()?.runAll()
    });
    app.commands.addCommand(CommandIds.export, {
      label: 'Export Student & Instructor Versions',
      isEnabled: hasNotebook,
      execute: () => current()?.exportVersions()
    });
    app.commands.addCommand(CommandIds.clearAnswers, {
      label: 'Remove All AI Answers From Notebook',
      isEnabled: () => !!current()?.stored().answers,
      execute: () => current()?.clearAll('answers')
    });
    app.commands.addCommand(CommandIds.clearSuggestions, {
      label: 'Remove All 💡 Suggestions From Notebook',
      isEnabled: () => !!current()?.stored().suggestions,
      execute: () => current()?.clearAll('suggestions')
    });

    const category = 'AI-ssignment';
    if (palette) {
      Object.values(CommandIds).forEach(command =>
        palette.addItem({ command, category })
      );
    }
    app.contextMenu.addItem({
      type: 'separator',
      selector: '.jp-Notebook .jp-Cell',
      rank: 20
    });
    [
      CommandIds.insertText,
      CommandIds.insertMcq,
      CommandIds.insertCode,
      CommandIds.convert
    ].forEach((command, i) =>
      app.contextMenu.addItem({
        command,
        selector: '.jp-Notebook .jp-Cell',
        rank: 20.1 + i / 10
      })
    );

    const sidebar = new Sidebar({
      tracker,
      store,
      controllerFor: panel => controllers.get(panel),
      insert
    });
    sidebar.title.icon = icon;
    shell.add(sidebar, 'right', { rank: 50 });
    // Reopen the sidebar after a reload if it was open before.
    restorer?.add(sidebar, sidebar.id);
    // Open it on the very first start, so new users find it.
    void app.restored.then(() => {
      const key = 'aissignment:sidebar-shown';
      try {
        if (!window.localStorage.getItem(key)) {
          window.localStorage.setItem(key, '1');
          shell.activateById(sidebar.id);
        }
      } catch {
        // storage unavailable (private window): nothing to remember
      }
    });
  }
};

export default plugin;
