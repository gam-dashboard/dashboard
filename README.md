Dashboard (Vite + React + TypeScript + Vega-Lite)



Local development:



&#x20;   npm install

&#x20;   npm run dev

&#x20;   Open http://localhost:5173



Build:



&#x20;   npm run build

&#x20;   Preview with: npm run preview



Deployment:



&#x20;   A GitHub Actions workflow will build the site on push to main and publish the dist output to the gh-pages branch.

&#x20;   The Vite base is set to /dashboard/ so the site will work as a project site at: https://<username>.github.io/dashboard/



Notes:



&#x20;   If you change the repository name or publish as a user site, update vite.config.ts base option.

&#x20;   The repo is initially private; you can make it public later from the repository Settings -> Options -> Change visibility.

