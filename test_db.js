'use strict';

// Checks that the database is reachable and that the data of the agents is
// there.
//
//   node test_db.js
//
const db = require('./db');
const config = require('./config');

async function main() {
    console.log('the database: ' + config.db.user + '@' + config.db.host + '/' + config.db.database);
    try {
        await db.ping();
        console.log('ok   the database answers');
    } catch (e) {
        console.log('FAIL the database does not answer: ' + e.message);
        process.exit(1);
    }

    try {
        const agent = await db.findAgent('agent1', 'secret');
        if (!agent) {
            console.log('FAIL the agent agent1 is not there (or the password is not secret)');
            process.exit(1);
        }
        console.log('ok   the agent agent1 -> extension ' + agent.sip_extension);

        const queues = await db.agentQueues(agent.id);
        console.log('ok   the queues: ' + (queues.join(', ') || 'none'));

        const reasons = await db.pauseReasons();
        console.log('ok   the pause reasons: ' + (reasons.join(', ') || 'none'));

        const secret = await db.sipSecret(agent.sip_extension);
        if (secret) {
            console.log('ok   the sip secret of ' + agent.sip_extension + ' is in the sip table');
        } else {
            console.log('WARN no sip secret for ' + agent.sip_extension + ' in the sip table, '
                + 'create the extension in Issabel (the agent can log in but it will not register)');
        }

        await db.logEvent(agent.id, 'login');
        console.log('ok   the log of the agent works');

        // the lists of the supervisor
        const extensions = await db.listExtensions();
        console.log('ok   the extensions of issabel: ' + (extensions.join(', ') || 'none'));

        const queuesOfIssabel = await db.listQueues();
        console.log('ok   the queues of issabel: ' + (queuesOfIssabel.join(', ') || 'none'));

        if (extensions.indexOf(agent.sip_extension) === -1) {
            console.log('WARN the extension ' + agent.sip_extension + ' of the agent is not '
                + 'in the list of issabel (it was not created in the user interface)');
        }

        // the queues of the list are the ones of issabel, a queue that only an
        // agent has (it was deleted in issabel) is not one of them
        const orphan = (await db.allAgentQueues())
            .filter((queue) => queuesOfIssabel.indexOf(queue) === -1);
        if (orphan.length) {
            console.log('WARN the queue ' + orphan.join(', ') + ' of an agent does not exist '
                + 'in issabel (the supervisor does not see it in the list of the queues)');
        } else {
            console.log('ok   every queue of an agent exists in issabel');
        }
    } catch (e) {
        console.log('FAIL the queries failed: ' + e.message);
        process.exit(1);
    }

    console.log('\nthe database is ready');
    process.exit(0);
}

main();
