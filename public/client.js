const socket = io();

const loginBox = document.getElementById('login-box');
const gameBox = document.getElementById('game-box');
const usernameInput = document.getElementById('username-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const roomTitle = document.getElementById('room-title');
const playersList = document.getElementById('players-list');
const startBtn = document.getElementById('start-btn');
const roleDisplay = document.getElementById('role-display');
const timerDisplay = document.getElementById('timer');
const notesSection = document.getElementById('notes-section');
const noteInput = document.getElementById('note-input');
const submitNoteBtn = document.getElementById('submit-note-btn');
const notesContainer = document.getElementById('notes-container');
const votingSection = document.getElementById('voting-section');
const votingSelect = document.getElementById('voting-select');
const submitVoteBtn = document.getElementById('submit-vote-btn');

let countdownInterval;

function selectRoom(name) {
    roomInput.value = name;
}

joinBtn.onclick = () => {
    const username = usernameInput.value.trim();
    const roomName = roomInput.value.trim();

    if(username && roomName) {
        socket.emit('joinRoom', { username, roomName });
        loginBox.style.display = 'none';
        gameBox.style.display = 'block';
        roomTitle.innerText = `🕵️‍♂️ غرفة العمليات: ${roomName}`;
    } else {
        alert('فضلاً، أدخل اسمك واسم الروم أولاً!');
    }
};

startBtn.onclick = () => {
    socket.emit('startGame');
};

socket.on('updatePlayers', (players) => {
    playersList.innerHTML = '<div style="text-align:right; margin-bottom:10px; color:#94a3b8;">العملاء في الغرفة:</div>';
    players.forEach(p => {
        playersList.innerHTML += `<div class="player-tag">🟢 العميل: <b>${p.username}</b></div>`;
    });
});

socket.on('gameRole', (data) => {
    startBtn.style.display = 'none';
    notesContainer.innerHTML = '';
    votingSection.style.display = 'none';
    roleDisplay.innerText = data.word;
});

socket.on('startNotesTimer', (seconds) => {
    notesSection.style.display = 'block';
    noteInput.value = '';
    let timeLeft = seconds;
    timerDisplay.innerText = `⏱️ الوقت المتبقي: ${timeLeft} ثانية`;

    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        timeLeft--;
        timerDisplay.innerText = `⏱️ الوقت المتبقي: ${timeLeft} ثانية`;

        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            notesSection.style.display = 'none';
        }
    }, 1000);
});

submitNoteBtn.onclick = () => {
    const text = noteInput.value.trim();
    socket.emit('sendNote', text);
    clearInterval(countdownInterval);
    notesSection.style.display = 'none';
    timerDisplay.innerText = '⏳ تم إرسال تلميحك بنجاح، بانتظار بقية العملاء...';
};

socket.on('allNotesRevealed', (allNotes) => {
    timerDisplay.innerText = '';
    notesContainer.innerHTML = '<h3 style="color:#38bdf8; text-align:right; margin-top:20px;">📝 تلميحات العملاء المكتشفة:</h3>';
    allNotes.forEach(note => {
        notesContainer.innerHTML += `<div class="note-card"><b>${note.username}:</b> ${note.text}</div>`;
    });
});

socket.on('startVotingPhase', (players) => {
    votingSection.style.display = 'block';
    votingSelect.innerHTML = '';
    players.forEach(p => {
        if (p.id !== socket.id) {
            votingSelect.innerHTML += `<option value="${p.id}">${p.username}</option>`;
        }
    });
});

submitVoteBtn.onclick = () => {
    const votedPlayerId = votingSelect.value;
    socket.emit('castVote', votedPlayerId);
    votingSection.style.display = 'none';
    timerDisplay.innerText = '🗳️ تم تسجيل صوتك السري، بانتظار فرز النتائج النهائية...';
};

socket.on('gameEnded', (msg) => {
    alert(msg);
    startBtn.style.display = 'inline-block';
    roleDisplay.innerText = '';
    timerDisplay.innerText = '';
    notesContainer.innerHTML = '';
    votingSection.style.display = 'none';
});

socket.on('errorMsg', (msg) => {
    alert(msg);
    window.location.reload();
});

// معالجة استقبال حدث الطرد وإعادة توجيه اللاعب المتأخر
socket.on('kicked', (msg) => {
    alert(msg);
    window.location.reload();
});