// Customer-provided test suite (plain Node, no frameworks).
const fs = require('fs');
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('ok -', name); }
  catch (e) { failed++; console.log('FAIL -', name, '-', e.message); }
}
const exists = (f) => fs.existsSync(f);
const read = (f) => fs.readFileSync(f, 'utf8');
check('index.html exists', () => { if (!exists('index.html')) throw new Error('create index.html'); });
check('styles.css exists', () => { if (!exists('styles.css')) throw new Error('create styles.css'); });
check('app.js exists', () => { if (!exists('app.js')) throw new Error('create app.js'); });
check('index.html has <h1>Todo App</h1>', () => { if (!/<h1>[^<]*Todo App/i.test(read('index.html'))) throw new Error('missing <h1>Todos App heading'); });
check('index.html has #todo-input', () => { if (!read('index.html').includes('todo-input')) throw new Error('missing id="todo-input"'); });
check('index.html has #add-btn', () => { if (!read('index.html').includes('add-btn')) throw new Error('missing id="add-btn"'); });
check('index.html has #todo-list', () => { if (!read('index.html').includes('todo-list')) throw new Error('missing id="todo-list"'); });
check('index.html links styles.css', () => { if (!read('index.html').includes('styles.css')) throw new Error('missing <link ... styles.css>'); });
check('app.js defines addTodo', () => { if (!/function\s+addTodo\b|addTodo\s*[:=]/.test(read('app.js'))) throw new Error('define function addTodo(text)'); });
check('app.js defines toggleTodo', () => { if (!/function\s+toggleTodo\b|toggleTodo\s*[:=]/.test(read('app.js'))) throw new Error('define function toggleTodo(index)'); });
check('app.js defines deleteTodo', () => { if (!/function\s+deleteTodo\b|deleteTodo\s*[:=]/.test(read('app.js'))) throw new Error('define function deleteTodo(index)'); });
check('app.js wires add button', () => { if (!/add-btn/.test(read('app.js'))) throw new Error('wire the add-btn click event'); });
check('styles.css has color rules', () => { if (!/background|color/.test(read('styles.css'))) throw new Error('add background/color rules'); });
process.exit(failed ? 1 : 0);
