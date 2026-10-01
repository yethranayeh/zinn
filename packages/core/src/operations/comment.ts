import type { CommentWithKey } from "../types";
import type { CommentCreateInput, CommentDeleteInput, CommentEditInput } from "../schemas/comment";
import type { Actor } from "../schemas/actor";

import { getDb } from "../db";

import * as dbTask from "../db/task";
import * as dbComment from "../db/comment";

import { validateTaskInput } from "../schemas/task";
import { actorSchema } from "../schemas/actor";
import { commentCreateSchema, commentDeleteSchema, commentEditSchema } from "../schemas/comment";

import {
  getTaskByKey,
  getCommentByKey,
  attachCommentKey,
  updateTaskSearchRecord,
  recordTaskActivity,
} from "./shared";

function describeComment(comment: CommentWithKey) {
  return { id: comment.id, key: comment.key, text: comment.text };
}

export const comment = {
  getByKey: getCommentByKey,
  getAll: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);
    return dbComment
      .getAllByTaskId(taskMatch.id)
      .map((commentMatch) => attachCommentKey(commentMatch, taskMatch.key));
  },
  create: (input: CommentCreateInput, actor: Actor) => {
    const props = validateTaskInput(commentCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const taskMatch = getTaskByKey(props.taskKey);
      const counter = dbTask.incrementCommentCounterById(taskMatch.id);

      if (counter == null) {
        throw new Error(`Task comment number could not be retrieved for "${taskMatch.key}"`);
      }

      const createdComment = attachCommentKey(
        dbComment.create({
          task_id: taskMatch.id,
          number: counter.comment_count,
          text: props.text,
        })!,
        taskMatch.key,
      );
      updateTaskSearchRecord(taskMatch.id);

      recordTaskActivity(validActor, {
        taskId: taskMatch.id,
        action: "comment_create",
        changes: { comment: describeComment(createdComment) },
        createdAt: createdComment.created_at,
      });

      return createdComment;
    }).immediate();
  },
  edit: (input: CommentEditInput, actor: Actor) => {
    const props = validateTaskInput(commentEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const existing = getCommentByKey(props.commentKey);

      if (existing.text === props.text) {
        return existing;
      }

      const now = Date.now();
      const editedComment = {
        ...dbComment.update({ id: existing.id, text: props.text, updated_at: now })!,
        key: existing.key,
      };
      updateTaskSearchRecord(existing.task_id);

      recordTaskActivity(validActor, {
        taskId: existing.task_id,
        action: "comment_edit",
        changes: {
          comment: { id: existing.id, key: existing.key },
          text: [existing.text, editedComment.text],
        },
        createdAt: now,
      });

      return editedComment;
    }).immediate();
  },
  delete: (input: CommentDeleteInput, actor: Actor) => {
    const props = validateTaskInput(commentDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const existing = getCommentByKey(props.commentKey);
      const now = Date.now();

      recordTaskActivity(validActor, {
        taskId: existing.task_id,
        action: "comment_delete",
        changes: { comment: describeComment(existing) },
        createdAt: now,
      });
      dbComment.deleteById(existing.id);
      updateTaskSearchRecord(existing.task_id);

      return existing;
    }).immediate();
  },
};
