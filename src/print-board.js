const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { fetchBoard } = require('./github');

const days = Number(process.env.DAYS || process.argv[2] || 1);

fetchBoard({ days })
  .then((board) => {
    console.log(
      `${board.org} @ ${board.host}  ${board.start}..${board.date}  ${board.days}d ${board.tz}`
    );
    console.log(
      `commits=${board.commitCount}  people=${board.peopleCount}  prs=${board.prCount}`
    );
    if (board.series?.length > 1) {
      console.log(
        board.series
          .map((d) => `${d.date.slice(5)}:${d.commits}/${d.you}`)
          .join('  ')
      );
    }
    for (const person of board.people) {
      const mark = person.login === board.you.login ? ' *' : '';
      console.log(
        `${String(person.rank).padStart(3)}  ${String(person.handle || person.login).padEnd(20)} ${String(person.commits).padStart(3)}c  ${person.prs}pr${mark}`
      );
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
