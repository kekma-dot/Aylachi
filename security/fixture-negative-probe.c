#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int write_file(const char *path, const char *text) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) { fprintf(stderr, "%s errno=%d\n", path, errno); return 1; }
    size_t n = strlen(text);
    ssize_t written = write(fd, text, n);
    int saved = errno;
    close(fd);
    if (written != (ssize_t)n) { fprintf(stderr, "%s write_errno=%d\n", path, saved); return 1; }
    return 0;
}

int main(void) {
    if (write_file("/workspace/positive.txt", "workspace-ok\n")) return 10;
    if (write_file("/tmp/private.txt", "tmp-ok\n")) return 11;
    errno = 0;
    int fd = open("/forbidden-write", O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
        close(fd);
        puts("forbidden-write unexpectedly succeeded");
        return 20;
    }
    int denied_errno = errno;
    if (denied_errno != EROFS && denied_errno != EACCES && denied_errno != EPERM) {
        fprintf(stderr, "unexpected errno=%d\n", denied_errno);
        return 21;
    }
    printf("workspace=ok tmp=ok forbidden_errno=%d\n", denied_errno);
    return 0;
}
