import { Aki } from 'aki-api';

export const AKINATOR_ANSWER_CHOICES = [
    'Yes',
    'No',
    'Don\'t know',
    'Probably',
    'Probably not'
];

export const AKINATOR_TIMEOUT_MS = 30_000;

export function parseAkinatorAnswer(value) {
    if (typeof value !== 'string' || !/^[1-5]$/.test(value.trim())) return undefined;
    return Number(value.trim()) - 1;
}

export function parseAkinatorConfirmation(value) {
    if (typeof value !== 'string') return undefined;
    const answer = value.trim().toLowerCase();
    if (['yes', 'y', 'হ্যাঁ'].includes(answer)) return true;
    if (['no', 'n', 'না'].includes(answer)) return false;
    return undefined;
}

export function formatAkinatorQuestion(game) {
    return [
        `*Akinator — Question ${game.currentStep + 1}*`,
        game.question,
        '',
        ...AKINATOR_ANSWER_CHOICES.map((choice, index) => `${index + 1}. ${choice}`),
        '',
        'Reply with 1, 2, 3, 4, or 5 within 30 seconds.'
    ].join('\n');
}

export function formatAkinatorGuess(game) {
    const someone = game.answers[0];
    return [
        '*Akinator’s guess*',
        `*${someone.name}*`,
        someone.description,
        `Ranking: #${someone.ranking}`,
        '',
        'Is this your character? Reply `yes` or `no` within 30 seconds.'
    ].join('\n');
}

export function isAkinatorFinished(game) {
    return game.progress >= 70 || game.currentStep >= 78;
}

export class AkinatorGame {
    constructor() {
        this.api = new Aki({ region: 'en' });
    }

    get answers() {
        return this.api.answers;
    }

    get currentStep() {
        return this.api.currentStep;
    }

    get question() {
        return this.api.question;
    }

    get progress() {
        return this.api.progress;
    }

    get ended() {
        return isAkinatorFinished(this.api);
    }

    get imageUrl() {
        const imageUrl = this.answers?.[0]?.absolute_picture_path;
        return typeof imageUrl === 'string' && imageUrl.startsWith('https://')
            ? imageUrl
            : undefined;
    }

    start() {
        return this.api.start();
    }

    answer(choice) {
        return this.api.step(choice);
    }

    confirm() {
        return this.api.win();
    }
}
