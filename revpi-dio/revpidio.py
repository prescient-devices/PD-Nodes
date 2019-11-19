import revpimodio2
import sys
def eventfunction(ioname, iovalue):
        #print("Event {} has the value of {}".format(ioname,iovalue))
       print(iovalue)

try:
    raw_input          # Python 2
except NameError:
    raw_input = input  # Python 3

if len(sys.argv) > 2:
    cmd = sys.argv[1].lower()
    pin_input = sys.argv[2]
    if cmd == "in":
        rpi = revpimodio2.RevPiModIO(autorefresh=True,direct_output=True)
        rpi.handlesignalend()
        print(rpi.io[pin_input].value)
        #rpi.io[pin_input].reg_event(eventfunction)
        #print("Starting main loop")
        rpi.mainloop()

        while True:
            try:
                data = raw_input()
                if 'close' in data:
                    sys.exit(0)
            except (EOFError, SystemExit):        # hopefully always caused by us sigint'ing the program
                sys.exit(0)
else:
    print("Bad parameters - input_pin")
