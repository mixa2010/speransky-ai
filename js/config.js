/* Конфигурация: константы, Telegram initData, селектор $. Выделено из app.js; загружается до app.js
   и разделяет с ним глобальную область (обычный скрипт). */
'use strict';
// iOS WKWebView не умеет стриминговое чтение fetch — там сразу просим целиком
const NO_STREAM = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const DEFAULT_API = 'https://homework-bot-6h3b.onrender.com';
const _params = new URLSearchParams(location.search);
const API_BASE = DEFAULT_API.replace(/\/+$/, '');
const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
const INIT_DATA = (tg && tg.initData) || _params.get('initData') || '';
const VOICE_DISABLED_MESSAGE = 'Голосовой ввод отключён — напишите запрос текстом';

const $ = (s) => document.querySelector(s);

