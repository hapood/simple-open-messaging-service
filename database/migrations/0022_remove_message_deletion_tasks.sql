-- Message deletion now commits directly; only its content fanouts remain durable.
DELETE FROM "DurableTask" WHERE "taskType" = 'DELETE_MESSAGE';
