import chalk from 'chalk';
import {Spinner} from 'cli-spinner';

const spinnerGlyphs = '|/-\\';
let activeSpinner = null;

const stopActiveSpinner = () => {
  if (activeSpinner) {
    activeSpinner.stop(true);
    activeSpinner = null;
  }
};

const logFactory = (symbol, color, writer = console.log) => (message = '', ...args) => {
  stopActiveSpinner();
  writer(`${color(symbol)} ${message}`, ...args);
};

const info = logFactory('ℹ', chalk.cyanBright);
const success = logFactory('✓', chalk.greenBright);
const warn = logFactory('!', chalk.yellowBright);
const error = logFactory('✗', chalk.redBright, console.error);
const note = logFactory('•', chalk.magentaBright);

const headline = (message = '') => {
  stopActiveSpinner();
  console.log(chalk.bold.white(message));
};

const detail = (message = '', ...args) => {
  stopActiveSpinner();
  console.log(`${chalk.gray('›')} ${chalk.gray(message)}`, ...args);
};

const divider = () => {
  stopActiveSpinner();
  console.log(chalk.gray('─'.repeat(40)));
};

const blank = () => {
  stopActiveSpinner();
  console.log('');
};

const startSpinner = (text) => {
  stopActiveSpinner();
  const spinner = new Spinner(`${chalk.gray(text)} %s`);
  spinner.setSpinnerString(spinnerGlyphs);
  spinner.start();
  activeSpinner = spinner;

  const finalize = () => {
    if (activeSpinner === spinner) {
      spinner.stop(true);
      activeSpinner = null;
    } else {
      spinner.stop(true);
    }
  };

  return {
    update: (message) => {
      spinner.setSpinnerTitle(`${chalk.gray(message)} `);
    },
    stop: finalize,
    succeed: (message) => {
      finalize();
      success(message || text);
    },
    fail: (message) => {
      finalize();
      error(message || text);
    }
  };
};

export default {
  info,
  success,
  warn,
  error,
  note,
  detail,
  divider,
  blank,
  headline,
  startSpinner
};

export {
  info,
  success,
  warn,
  error,
  note,
  detail,
  divider,
  blank,
  headline,
  startSpinner
};

