import { Notification } from './Notification';
import { SurveyItem, User } from '../types';

const DEFAULT_INSTRUCTIONS = `1. Sign into your Amazon account (top of the page) - this is required, the task can't be completed while signed out.
2. Shop for the product category described in your initial survey and add an item to your cart.
3. Once you reach your Amazon cart, come back to this popup - a link to the final survey will appear here.
4. Click that link and complete the final survey to finish the study.`;

class Popup {
  private continueButton: HTMLButtonElement;
  private logInInput: HTMLInputElement;
  private getStartedContainer: HTMLElement;
  private studyExtensionContainer: HTMLElement;
  private copyButton: HTMLButtonElement;
  private formattedIdentifier: HTMLElement;
  private fullIdentifier: string;
  private shopLink: HTMLAnchorElement;
  private notification: Notification;
  private instructionsButton: HTMLButtonElement;
  private instructionsPanel: HTMLElement;
  private loginWarningBanner: HTMLElement;
  private isInstructionsOpen: boolean;

  constructor() {
    this.continueButton = document.getElementById('continueButton') as HTMLButtonElement;
    this.logInInput = document.getElementById('logInInput') as HTMLInputElement;
    this.getStartedContainer = document.getElementById('getStartedContainer') as HTMLElement;
    this.studyExtensionContainer = document.getElementById('studyExtensionContainer') as HTMLElement;
    this.copyButton = document.getElementById('copyButton') as HTMLButtonElement;
    this.formattedIdentifier = document.getElementById('formattedIdentifier') as HTMLElement;
    this.fullIdentifier = '';
    this.shopLink = document.getElementById('shopLink') as HTMLAnchorElement;
    this.notification = new Notification();
    this.instructionsButton = document.getElementById('instructionsButton') as HTMLButtonElement;
    this.instructionsPanel = document.getElementById('instructionsPanel') as HTMLElement;
    this.loginWarningBanner = document.getElementById('loginWarningBanner') as HTMLElement;
    this.isInstructionsOpen = false;

    this.init();
  }

  private init(): void {
    this.initListeners();
    this.initView();
  }

  private initListeners(): void {
    this.continueButton.addEventListener('click', () => this.onContinueButtonClick());
    this.copyButton.addEventListener('click', () => this.copyIdentifier());
    this.instructionsButton.addEventListener('click', () => this.toggleInstructions());
    chrome.runtime.onMessage.addListener((response: any) => this.onRuntimeMessage(response));
  }

  private onRuntimeMessage(response: any): void {
    if (response?.action === 'webmunkExt.popup.getInstructionsRes') {
      this.instructionsPanel.textContent = response.instructions || DEFAULT_INSTRUCTIONS;
    }
  }

  private async toggleInstructions(): Promise<void> {
    this.isInstructionsOpen = !this.isInstructionsOpen;
    this.instructionsPanel.style.display = this.isInstructionsOpen ? 'block' : 'none';

    if (this.isInstructionsOpen) {
      this.instructionsPanel.textContent = DEFAULT_INSTRUCTIONS;
      await chrome.runtime.sendMessage({ action: 'webmunkExt.popup.getInstructionsReq' });
    }
  }

  private async updateLoginWarning(): Promise<void> {
    const { amazonLoginConfirmed, taskStage } = await chrome.storage.local.get(['amazonLoginConfirmed', 'taskStage']);
    const needsLoginWarning = (taskStage === 'shopping' || taskStage === 'final') && !amazonLoginConfirmed;

    this.loginWarningBanner.style.display = needsLoginWarning ? 'block' : 'none';
  }

  private async onContinueButtonClick() {
    const inputValue = this.logInInput.value.trim();

    if (!this.validateInput(inputValue)) {
      return;
    }

    this.setButtonState(true, 'Wait...');

    try {
      const user: User | undefined = await this.login(inputValue);

      if (!user || !user.uid) {
        throw new Error('Login failed, please try again.');
      }

      await chrome.runtime.sendMessage({ action: 'webmunkExt.popup.successRegister' });
      setTimeout(() => this.showStudyExtensionContainer(user.uid), 100);
    } catch (error: any) {
      const message =
        typeof error === 'string'
          ? error
          : 'Enrollment hiccup!\nPlease give it another shot a bit later. We appreciate your patience!';

      this.notification.warning(message);
      this.setButtonState(false, 'Continue');
    }
  }

  private validateInput(inputValue: string): boolean {
    if (!inputValue) {
      this.notification.warning('Please enter a Prolific ID.');
      return false;
    }

    const isValid = this.prolificIdValidation(inputValue);

    if (!isValid) {
      this.notification.warning('Please enter a valid Prolific ID (24 alphanumeric characters).');
      return false;
    }

    return true;
  }

  private async login(prolificId: string): Promise<User> {
    return new Promise((resolve, reject) => {
      const messageHandler = (response: any) => {
        if (response.action === 'webmunkExt.popup.loginRes') {
          chrome.runtime.onMessage.removeListener(messageHandler);

          if (response.error) {
            reject(response.error);
          } else {
            resolve(response.data);
          }
        }
      };

      chrome.runtime.onMessage.addListener(messageHandler);
      chrome.runtime.sendMessage({ action: 'webmunkExt.popup.loginReq', prolificId });
    });
   }

  private async showStudyExtensionContainer(uid: string): Promise<void> {
    this.getStartedContainer.style.display = 'none';
    this.studyExtensionContainer.style.display = 'block';
    this.initSurveys();
    this.updateLoginWarning();
    this.formattedIdentifier.innerHTML = this.formatIdentifier(uid);
    this.fullIdentifier = uid;
  }

  private showGetStartedContainer(): void {
    this.getStartedContainer.style.display = 'block';
    this.studyExtensionContainer.style.display = 'none';
  }

  private formatIdentifier(identifier: string): string {
    const firstTenSymbols = identifier.substring(0, 10);
    const lastTenSymbols = identifier.substring(identifier.length - 10);

    return `${firstTenSymbols}...${lastTenSymbols}`;
  }

  private async initView(): Promise<void> {
    const result = await chrome.storage.local.get('user');
    const user = result.user as User;

    user ? await this.showStudyExtensionContainer(user.uid) : this.showGetStartedContainer();
  }

  private async initSurveys(): Promise<void> {
    const result = await chrome.storage.local.get(['surveys', 'taskStage']);
    const surveys: SurveyItem[] = result.surveys || [];
    const taskStage: string = result.taskStage || 'initial';
    const taskList = document.getElementById('task-list') as HTMLElement;
    const tasksStatus = document.getElementById('tasks-status') as HTMLElement;

    taskList.innerHTML = '';
    this.shopLink.style.display = 'none';

    surveys.forEach((survey) => {
      const listItem = document.createElement('li');
      const link = document.createElement('a');
      link.href = survey.url;
      link.textContent = survey.name;
      link.target = '_blank';
      listItem.appendChild(link);
      taskList.appendChild(listItem);
    });

    if (surveys.length) {
      tasksStatus.textContent = 'Please complete these tasks:';
    } else if (taskStage === 'shopping') {
      tasksStatus.textContent = 'When you\'re done shopping, go to your cart to finish.';
      this.shopLink.href = 'https://www.amazon.com/gp/cart/view.html';
      this.shopLink.style.display = 'inline-flex';
    } else {
      tasksStatus.textContent = 'All tasks are completed!';
    }
  }

  private async copyIdentifier(): Promise<void> {
    await navigator.clipboard.writeText(this.fullIdentifier);
    this.notification.info('Identifier copied to clipboard');
  }

  private setButtonState(isDisabled: boolean, text: string): void {
    this.continueButton.disabled = isDisabled;
    this.continueButton.textContent = text;
  }

  private prolificIdValidation(id: string): boolean {
    const idPattern = /^[a-fA-F0-9]{24}$/;
    return idPattern.test(id);
  }
}

document.addEventListener('DOMContentLoaded', () => new Popup());
