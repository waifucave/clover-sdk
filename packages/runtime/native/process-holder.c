// process-holder: runs one command so that everything it starts can be found and stopped, even what it leaves behind
// (macOS). Built and signed by the host under its own identifier, never the host's.
//
//   process-holder <status-fd> <file> [args...]
//
// 1. It re-executes itself in place (POSIX_SPAWN_SETEXEC, same pid) with its responsibility disclaimed, so it is the
//    responsible process of every process the command starts: a background job, a nohup, a setsid or a double fork that
//    reparents to launchd, one that clears its environment. `responsibility_get_pid_responsible_for_pid` names it for
//    each of them for as long as it lives (it reverts once the responsible process is gone, so the holder stays).
// 2. It runs the command as its child and waits for it, then writes `exit <code> <left>` (or `signal <n> <left>`) to
//    the status fd and closes it, `<left>` being how many processes the command left behind.
// 3. While any remain it stays, looking once a second, and exits when none do: the host adopts it as a background task.
// 4. SIGTERM (or SIGINT, SIGHUP) stops everything: the command and every process responsible to the holder get SIGTERM,
//    then SIGKILL two seconds later, and the holder exits.
//
// Not caught: a process the command has launchd start (launchctl, open, an XPC service) is launchd's, not a
// descendant; the host's sandbox profile denies those paths.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);

#define DISCLAIMED_FLAG "PROCESS_HOLDER_DISCLAIMED"

static volatile sig_atomic_t stop_requested = 0;
static pid_t command_pid = -1;

static void on_stop(int sig) {
  (void)sig;
  stop_requested = 1;
}

/* The processes responsible to this holder, other than itself; up to `max` of them in `out`. */
static int left_behind(pid_t *out, int max) {
  pid_t self = getpid();
  int n = proc_listallpids(NULL, 0);
  if (n <= 0) return 0;
  pid_t *all = calloc((size_t)n + 256, sizeof(pid_t));
  if (all == NULL) return 0;
  n = proc_listallpids(all, (int)(((size_t)n + 256) * sizeof(pid_t)));
  int found = 0;
  for (int i = 0; i < n; i++) {
    pid_t p = all[i];
    if (p <= 1 || p == self) continue;
    if (responsibility_get_pid_responsible_for_pid(p) != self) continue;
    if (found < max) out[found] = p;
    found++;
  }
  free(all);
  return found;
}

static void reap(void) {
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
}

static void sleep_ms(long ms) {
  struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
}

/* Stops the command and everything responsible to the holder: SIGTERM, then SIGKILL after two seconds. */
static void stop_all(void) {
  pid_t pids[4096];
  if (command_pid > 0) kill(command_pid, SIGTERM);
  int n = left_behind(pids, 4096);
  for (int i = 0; i < n && i < 4096; i++) kill(pids[i], SIGTERM);
  for (int t = 0; t < 20; t++) {
    reap();
    if (left_behind(pids, 4096) == 0 && (command_pid <= 0 || kill(command_pid, 0) != 0)) return;
    sleep_ms(100);
  }
  if (command_pid > 0) kill(command_pid, SIGKILL);
  n = left_behind(pids, 4096);
  for (int i = 0; i < n && i < 4096; i++) kill(pids[i], SIGKILL);
  reap();
}

static void write_status(int fd, const char *what, int value, int left) {
  if (fd < 0) return;
  char line[64];
  int len = snprintf(line, sizeof line, "%s %d %d\n", what, value, left);
  if (len > 0) (void)!write(fd, line, (size_t)len);
  close(fd);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: process-holder <status-fd> <file> [args...]\n");
    return 64;
  }
  // Step 1: become the responsible process of everything below, in place (same pid, same descriptors). The flag in
  // the environment marks the second pass; it is taken out again before the command starts.
  if (getenv(DISCLAIMED_FLAG) == NULL) {
    char self[PROC_PIDPATHINFO_MAXSIZE];
    posix_spawnattr_t attr;
    if (proc_pidpath(getpid(), self, sizeof self) > 0 && posix_spawnattr_init(&attr) == 0) {
      short flags = 0;
      posix_spawnattr_getflags(&attr, &flags);
      posix_spawnattr_setflags(&attr, flags | POSIX_SPAWN_SETEXEC);
      if (responsibility_spawnattrs_setdisclaim(&attr, 1) == 0) {
        setenv(DISCLAIMED_FLAG, "1", 1);
        pid_t ignored;
        posix_spawn(&ignored, self, NULL, &attr, argv, environ);
        // Only reached when the re-exec failed: go on undisclaimed (the host still has the process group).
        unsetenv(DISCLAIMED_FLAG);
      }
      posix_spawnattr_destroy(&attr);
    }
  }
  unsetenv(DISCLAIMED_FLAG);

  int status_fd = atoi(argv[1]);
  if (status_fd > 2) fcntl(status_fd, F_SETFD, FD_CLOEXEC);
  else status_fd = -1;

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_stop;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);

  // Step 2: the command, as this holder's child, in its process group.
  posix_spawnattr_t cattr;
  posix_spawnattr_init(&cattr);
  sigset_t none;
  sigemptyset(&none);
  posix_spawnattr_setsigmask(&cattr, &none);
  sigset_t defaults;
  sigemptyset(&defaults);
  sigaddset(&defaults, SIGTERM);
  sigaddset(&defaults, SIGINT);
  sigaddset(&defaults, SIGHUP);
  sigaddset(&defaults, SIGPIPE);
  posix_spawnattr_setsigdefault(&cattr, &defaults);
  posix_spawnattr_setflags(&cattr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  int rc = posix_spawn(&command_pid, argv[2], NULL, &cattr, &argv[2], environ);
  posix_spawnattr_destroy(&cattr);
  if (rc != 0) {
    fprintf(stderr, "process-holder: could not start %s: %s\n", argv[2], strerror(rc));
    write_status(status_fd, "exit", 127, 0);
    return 127;
  }
  int wstatus = 0;
  for (;;) {
    pid_t r = waitpid(command_pid, &wstatus, 0);
    if (r == command_pid) break;
    if (r < 0 && errno != EINTR) break;
    if (stop_requested) {
      stop_all();
      write_status(status_fd, "signal", SIGTERM, 0);
      return 143;
    }
  }
  command_pid = -1;
  pid_t pids[1];
  int left = left_behind(pids, 1);
  // The command's output pipes are the host's: the holder lets go of its own copies, so they close once nothing the
  // command left is writing to them.
  int devnull = open("/dev/null", O_RDWR);
  if (devnull >= 0) {
    dup2(devnull, STDIN_FILENO);
    dup2(devnull, STDOUT_FILENO);
    dup2(devnull, STDERR_FILENO);
    if (devnull > 2) close(devnull);
  }
  if (WIFSIGNALED(wstatus)) write_status(status_fd, "signal", WTERMSIG(wstatus), left);
  else write_status(status_fd, "exit", WEXITSTATUS(wstatus), left);

  // Step 3: stay while anything the command left runs; step 4 on a stop.
  while (left > 0) {
    if (stop_requested) {
      stop_all();
      return 143;
    }
    sleep_ms(1000);
    reap();
    left = left_behind(pids, 1);
  }
  return 0;
}
