import type { Notice } from '../../../shared/types';

type Action = NonNullable<Notice['action']>;

const ACTION_LABEL: Record<Action, string> = {
  enableCapture: 'Enable query capture',
  disableCapture: 'Stop capturing',
};

/** A dismissible banner for conditions the user can act on. Built with textContent only. */
export class NoticeBanner {
  private root = document.createElement('div');
  private text = document.createElement('div');
  private actions = document.createElement('div');
  private dismissedKey = '';
  private current: Notice | null = null;

  constructor(private onAction: (action: Action) => void) {
    this.root.id = 'notice';
    this.root.style.display = 'none';
    this.text.className = 'notice-text';
    this.actions.className = 'notice-actions';
    const close = document.createElement('button');
    close.className = 'notice-close';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.addEventListener('click', () => {
      this.dismissedKey = JSON.stringify(this.current);
      this.root.style.display = 'none';
    });
    this.root.append(this.text, this.actions, close);
    document.body.appendChild(this.root);
  }

  show(notice: Notice | null): void {
    this.current = notice;
    if (!notice || JSON.stringify(notice) === this.dismissedKey) {
      this.root.style.display = 'none';
      return;
    }
    this.root.className = `panel ${notice.level}`;
    this.root.id = 'notice';
    this.root.style.display = '';
    this.text.textContent = notice.message;
    this.actions.replaceChildren();
    if (notice.action) {
      const action = notice.action;
      const button = document.createElement('button');
      button.textContent = ACTION_LABEL[action];
      button.addEventListener('click', () => this.onAction(action));
      this.actions.append(button);
    }
  }
}
