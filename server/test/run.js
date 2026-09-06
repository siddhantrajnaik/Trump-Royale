const { run } = require('./harness');

require('./joker.test');
require('./rules.test');
require('./sw.test');
require('./music.test');
require('./client.test');

run();
