function addTodo(text) {
    const li = document.createElement('li');
    li.textContent = text;
    document.getElementById('todo-list').appendChild(li);
}

function toggleTodo(index) {
    const list = document.getElementById('todo-list');
    const li = list.children[index];
    li.classList.toggle('completed');
}

function deleteTodo(index) {
    const list = document.getElementById('todo-list');
    list.removeChild(list.children[index]);
}

document.getElementById('add-btn').addEventListener('click', () => {
    const input = document.getElementById('todo-input');
    const text = input.value;
    addTodo(text);
});