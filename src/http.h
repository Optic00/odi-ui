/*
 * The HTTP layer: reading a request safely, deciding whether to answer it, and
 * the two ways bytes leave -- a response header and a static file.
 *
 * Everything here treats the request as hostile input. Two of these functions
 * have already cost real debugging by editing their input in place, so the
 * rule is stated once: request_path NUL-terminates the method and the path
 * where they sit, which stops any later header scan dead. Call header_copy and
 * request_body BEFORE request_path, never after.
 */

#ifndef CONFD_HTTP_H
#define CONFD_HTTP_H

#define REQ_INCOMPLETE (-1)
#define REQ_TOO_LARGE  (-2)

/* A ceiling on a declared Content-Length, so the parse cannot wrap. Not a
 * policy limit -- the upload route sets its own, much lower. */
#define MAX_BODY  (32u * 1024u * 1024u)

void respond(int fd, const char *status_line, const char *ctype,
	     const char *extra);
/*
 * A 200 that the browser may keep and revalidate, tagged from `body`, or a 304
 * when the request already holds that tag. Returns 1 for the 304: the caller
 * then writes no body. note_cache_request takes the request first, from
 * serve(), before request_path cuts it.
 */
void note_cache_request(const char *r);
int respond_cached(int fd, const char *ctype, const char *body, unsigned long len);
/* The same tag built in steps, for an answer made from several files:
 * etag_add over each, then respond_tagged (1 for the 304, as above). */
unsigned long etag_start(void);
unsigned long etag_add(unsigned long h, const char *b, unsigned long len);
int respond_tagged(int fd, const char *ctype, unsigned long h);
char *request_path(char *r, char **method);
char *request_body(char *r);
int header_copy(const char *r, const char *name, char *out, unsigned long cap);
/*
 * Read a request. Returns the bytes in `buf` (headers, plus as much of the body
 * as fits), or a REQ_* code.
 *
 * `body_have` and `body_want` are what let one route stream a 3 MB firmware
 * image through a 16 KB buffer while every other route keeps refusing anything
 * that does not fit. A short body is no longer an error here -- it is reported,
 * and the caller decides. Every route except the upload treats
 * body_have < body_want as 413, which is exactly what this used to return.
 */
long read_request(int conn, char *buf, unsigned long cap,
		  unsigned long *body_have, unsigned long *body_want);
int same_origin(const char *r);
/* Host and Sec-Fetch-Site: 0 if the request may go on, else a reason line. */
const char *request_refusal(const char *r);
/* What authorised() found: a browser session, or an HTTP Basic header. */
#define AUTH_BASIC   1
#define AUTH_SESSION 2
int authorised(const char *r);
/* Whether user and pass are the credential in force (constant time). */
int credential_matches(const char *user, const char *pass);
/* Start a browser session; its token (32 hex digits) goes into tok[33]. */
int session_start(char *tok);
/* End the session the request carries, if it carries a live one. */
void session_end_current(const char *r);
/* End every session but the one the request being served signed in with. */
void session_end_others(void);
/*
 * The request target without its query, copied, for decisions made before
 * request_path() edits the request. 0 when it does not fit.
 */
int request_target(const char *r, char *out, unsigned long cap);
/* Whether a header holds `needle`, case-sensitive: Accept and text/html. */
int header_has(const char *r, const char *name, const char *needle);
/* Whether the credential came from the file or from the built-in default.
 * Reported to the page, because a well-known default that nobody can see is
 * the same thing as no password at all. */
int auth_is_default(void);
/* What the odi-oss safe-mode flag of this boot means for the web login:
 * "none" (no flag), "default", "stored" or "strict" (http.c). */
const char *safemode_login_name(void);
/* Whether `pass` is the password of the credential in force (constant time). */
int password_matches(const char *pass);
/* Write /etc/config/confd.auth. Returns 0 and sets *why on refusal. */
int set_credential(const char *user, const char *pass, const char **why);
unsigned long url_decode(const char *in, unsigned long i, char stop,
			 char *out, unsigned long cap);
int form_get(const char *body, const char *want, char *out, unsigned long cap);
int form_has(const char *body, const char *want);
int form_valid(const char *body);
unsigned long url_skip(const char *in, unsigned long i);
void serve_static(int fd, const char *name, const char *ctype);

/*
 * The complete set of files this daemon will serve, and the only set.
 *
 * A table rather than an if-chain because the web UI is many modules now, but
 * the security property is the reason it is a table of LITERALS: the request
 * path is only ever COMPARED against `url`, and it is `file` -- this table's
 * own string -- that reaches the filesystem. Nothing derived from the request
 * is ever concatenated into a path, so there is no traversal to get wrong.
 * `/etc/config/confd/` holds the credential; a served `..` would hand it out.
 */
struct web_asset {
	const char *url;
	const char *file;
	const char *ctype;
};

extern const struct web_asset web_assets[];

/* Serve `path` if it names an asset. Returns 0 if it does not. */
int serve_asset(int fd, const char *path);

#endif /* CONFD_HTTP_H */
