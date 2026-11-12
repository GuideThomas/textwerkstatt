/** @type {import('tailwindcss').Config} */
// Farben und Schriften kommen aus dem Thema (thema.config.js, client/themes/<name>/tailwind.json).
// Gescannt wird nur das gebaute Thema, damit Klassen eines anderen Themas nicht ins CSS geraten.
import { themaName, themaTailwind } from './thema.config.js';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', `./themes/${themaName()}/**/*.{js,ts,jsx,tsx}`],
  darkMode: 'class',
  theme: {
    extend: themaTailwind(),
  },
  plugins: [],
};
